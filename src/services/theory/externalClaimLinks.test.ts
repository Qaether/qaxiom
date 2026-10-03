// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createTheory, saveTheoryVersion } from './documents';
import { EMPTY_CONTRACT } from './types';
import { importReference } from '../retrieval/references';
import { prepareExternalReview, parseExternalResponse } from './externalReview';
import { reviewSkeleton } from './reviews';
import { acceptExternalClaim, prepareExternalClaimAcceptance, retractExternalClaim } from './externalClaims';
import { approveExternalClaimLink, loadExternalClaimLinks, prepareExternalClaimLink, retractExternalClaimLink, type ExternalClaimLinkInput } from './externalClaimLinks';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { saveProjectSources } from './projectSources';

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`claim-links-${crypto.randomUUID()}`); target = new QaxiomDatabase(`claim-links-target-${crypto.randomUUID()}`); });
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); await target.delete(); });

async function claim(title: string) {
  const snapshot = await createTheory({ title, markdown: `${title} positive.`, contract: { ...EMPTY_CONTRACT, assumptions: `${title} > 0` } }, db);
  const quote = `Independent ${title} result.`;
  const source = (await importReference(`${title}.md`, quote, 'external', db)).source;
  const span = (await db.reference_spans.where('sourceId').equals(source.id).first())!;
  const prepared = await prepareExternalReview(snapshot, [{ blockId: snapshot.blocks[0].id, spanId: span.id, theoryConditions: `all ${title}`, referenceConditions: `measured ${title}` }], db);
  const pairId = prepared.context.pairs[0].id;
  const parsed = parseExternalResponse(JSON.stringify({ checkedPairIds: [pairId], limitations: [], assessments: [{ pairId, label: 'different_scope',
    theoryQuote: `${title} positive.`, referenceQuote: quote, theoryConditions: `all ${title}`, referenceConditions: `measured ${title}`,
    explanation: '범위 차이', referenceClaim: { statement: `${title} result`, evidenceQuote: quote, kind: 'empirical', basis: 'author_statement', conditions: `measured ${title}` } }] }), prepared.context);
  const run = reviewSkeleton(snapshot, 'external-v1', [], 'mock');
  run.external = { context: prepared.context, checkedPairIds: parsed.checkedPairIds, assessments: parsed.assessments };
  await db.review_runs.add(run);
  const adopted = await acceptExternalClaim(await prepareExternalClaimAcceptance(run.id, pairId, db), db);
  return { snapshot, source, run, adopted };
}
async function fixture() {
  const a = await claim('A'), b = await claim('B');
  const input: ExternalClaimLinkInput = { fromProjectId: a.snapshot.document.projectId, toProjectId: b.snapshot.document.projectId,
    fromClaimId: a.adopted.id, toClaimId: b.adopted.id, kind: 'different_scope_candidate',
    fromConditions: 'all A', toConditions: 'measured B', note: '원문과 조건을 비교한 사용자 후보 판단' };
  return { a, b, input };
}

it('requires an explicit two-project preview, preserves both provenance anchors, and never calls a provider', async () => {
  const f = await fixture(), fetchMock = vi.spyOn(globalThis, 'fetch');
  const preview = await prepareExternalClaimLink(f.input, db);
  expect(await db.external_claim_links.count()).toBe(0);
  expect(preview.from.row.id).toBe(f.a.adopted.id); expect(preview.to.row.id).toBe(f.b.adopted.id);
  const row = await approveExternalClaimLink(preview, db);
  expect(row.fromAcceptedHash).toBe(preview.fromAcceptedHash); expect(row.toAcceptedHash).toBe(preview.toAcceptedHash);
  expect((await loadExternalClaimLinks(f.a.snapshot.document.projectId, db))[0].status).toBe('current');
  expect((await loadExternalClaimLinks(f.b.snapshot.document.projectId, db))[0].row.id).toBe(row.id);
  expect(fetchMock).not.toHaveBeenCalled();
  await expect(approveExternalClaimLink(preview, db)).rejects.toThrow('이미');
  const reversed = { ...f.input, fromProjectId: f.input.toProjectId, toProjectId: f.input.fromProjectId,
    fromClaimId: f.input.toClaimId, toClaimId: f.input.fromClaimId, fromConditions: f.input.toConditions, toConditions: f.input.fromConditions };
  await expect(approveExternalClaimLink(await prepareExternalClaimLink(reversed, db), db)).rejects.toThrow('이미');
});

it('rejects missing conditions, stale source policy, version and retracted claims before a link is written', async () => {
  const f = await fixture(), preview = await prepareExternalClaimLink(f.input, db);
  await expect(prepareExternalClaimLink({ ...f.input, note: '' }, db)).rejects.toThrow('입력');
  await saveProjectSources(f.b.snapshot, null, [], db);
  await expect(approveExternalClaimLink(preview, db)).rejects.toThrow();
  await saveProjectSources(f.b.snapshot, 1, [f.b.source.id], db);
  await expect(approveExternalClaimLink(preview, db)).rejects.toThrow();
  await saveTheoryVersion(f.a.snapshot.document.id, f.a.snapshot.version.id, { title: 'new', markdown: 'Changed A.', contract: f.a.snapshot.version.contract }, db);
  await expect(prepareExternalClaimLink(f.input, db)).rejects.toThrow('현재 범위');
  await retractExternalClaim(f.b.adopted.id, '재검토', db);
  await expect(prepareExternalClaimLink(f.input, db)).rejects.toThrow('현재 범위');
  expect(await db.external_claim_links.count()).toBe(0);
});

it('retains historical links when an endpoint is retracted and records a separate relation retraction', async () => {
  const f = await fixture(), row = await approveExternalClaimLink(await prepareExternalClaimLink(f.input, db), db);
  await retractExternalClaim(f.b.adopted.id, 'source assessment changed', db);
  expect((await loadExternalClaimLinks(f.a.snapshot.document.projectId, db))[0].status).toBe('stale');
  const retracted = await retractExternalClaimLink(row.id, '두 조건 재검토', db);
  expect(retracted.retractionNote).toBe('두 조건 재검토');
  expect((await loadExternalClaimLinks(f.a.snapshot.document.projectId, db))[0].status).toBe('retracted');
});

it('rolls back quota errors and serializes duplicate approvals across tabs', async () => {
  const f = await fixture(), preview = await prepareExternalClaimLink(f.input, db);
  const fail = () => { throw new Error('quota'); }; db.external_claim_links.hook('creating', fail);
  await expect(approveExternalClaimLink(preview, db)).rejects.toThrow('quota');
  db.external_claim_links.hook('creating').unsubscribe(fail); expect(await db.external_claim_links.count()).toBe(0);
  const results = await Promise.allSettled([approveExternalClaimLink(preview, db), approveExternalClaimLink(preview, db)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(await db.external_claim_links.count()).toBe(1);
});

it('roundtrips v21 links and rejects forged endpoints, kinds, conditions or hashes before replacing the workspace', async () => {
  const f = await fixture(), row = await approveExternalClaimLink(await prepareExternalClaimLink(f.input, db), db);
  const bundle = await createWorkspaceBundle(db); expect(bundle.version).toBe(22);
  await restoreWorkspaceBundle(bundle, target); expect((await target.external_claim_links.get(row.id))?.linkHash).toBe(row.linkHash);
  for (const edit of [
    (bad: typeof bundle) => { bad.data.externalClaimLinks[0].toClaimId = bad.data.externalClaimLinks[0].fromClaimId; },
    (bad: typeof bundle) => { bad.data.externalClaimLinks[0].kind = 'equivalent' as typeof row.kind; },
    (bad: typeof bundle) => { bad.data.externalClaimLinks[0].fromConditions = 'forged'; },
    (bad: typeof bundle) => { bad.data.externalClaimLinks[0].linkHash = '0'.repeat(64); }
  ]) {
    const bad = structuredClone(bundle); edit(bad);
    await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow();
    expect(await target.external_claim_links.get(row.id)).toEqual(row);
  }
});

it('imports v20 backups and upgrades a populated v20 database without inventing cross-project links', async () => {
  const f = await fixture(), bundle = await createWorkspaceBundle(db);
  await restoreWorkspaceBundle({ ...bundle, version: 20 }, target);
  expect(await target.external_claim_links.count()).toBe(0); expect(await target.external_claims.count()).toBe(2);
  await target.delete(); const legacy = new Dexie(target.name);
  legacy.version(20).stores(Object.fromEntries(db.tables.filter(t => t.name !== 'external_claim_links').map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const table of db.tables.filter(t => t.name !== 'external_claim_links')) await legacy.table(table.name).bulkAdd(await table.toArray());
  legacy.close(); await target.open();
  expect(target.verno).toBe(23); expect(await target.external_claim_links.count()).toBe(0);
  expect(await target.external_claims.get(f.a.adopted.id)).toEqual(f.a.adopted);
});
