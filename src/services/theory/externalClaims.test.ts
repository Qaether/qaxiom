// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createTheory, saveTheoryVersion } from './documents';
import { EMPTY_CONTRACT } from './types';
import { importReference } from '../retrieval/references';
import { prepareExternalReview, parseExternalResponse } from './externalReview';
import { reviewSkeleton } from './reviews';
import { acceptExternalClaim, prepareExternalClaimAcceptance, retractExternalClaim, externalClaimHash, loadProjectExternalClaims } from './externalClaims';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { saveProjectSources } from './projectSources';
import { moveTheoryProject } from './projects';

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`external-claim-${crypto.randomUUID()}`); target = new QaxiomDatabase(`external-claim-target-${crypto.randomUUID()}`); });
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); await target.delete(); });

async function fixture() {
  const snapshot = await createTheory({ title: '외부 주장', markdown: 'A positive.', contract: { ...EMPTY_CONTRACT, assumptions: 'A > 0' } }, db);
  const source = (await importReference('independent.md', 'Independent positive result.', 'external', db)).source;
  const span = (await db.reference_spans.where('sourceId').equals(source.id).first())!;
  const prepared = await prepareExternalReview(snapshot, [{ blockId: snapshot.blocks[0].id, spanId: span.id, theoryConditions: 'all A', referenceConditions: 'measured A' }], db);
  const pairId = prepared.context.pairs[0].id;
  const candidate = { statement: 'Independent positive result under measurement', evidenceQuote: 'Independent positive result.', kind: 'empirical', basis: 'author_statement', conditions: 'measured A' };
  const parsed = parseExternalResponse(JSON.stringify({ checkedPairIds: [pairId], limitations: [], assessments: [{ pairId, label: 'different_scope', theoryQuote: 'A positive.', referenceQuote: 'Independent positive result.', theoryConditions: 'all A', referenceConditions: 'measured A', explanation: '조건 차이', referenceClaim: candidate }] }), prepared.context);
  const run = reviewSkeleton(snapshot, 'external-v1', [], 'mock');
  run.external = { context: prepared.context, checkedPairIds: parsed.checkedPairIds, assessments: parsed.assessments };
  await db.review_runs.add(run);
  return { snapshot, source, span, pairId, run, candidate };
}

it('requires explicit preview and acceptance, then retains a retractable project/source-bound record without changing review', async () => {
  const f = await fixture(); const fetchMock = vi.spyOn(globalThis, 'fetch');
  const preview = await prepareExternalClaimAcceptance(f.run.id, f.pairId, db);
  expect(await db.external_claims.count()).toBe(0);
  expect(preview.candidate).toEqual(f.candidate); expect(preview.projectId).toBe(f.snapshot.document.projectId);
  const row = await acceptExternalClaim(preview, db);
  expect(row.claim.statement).toBe(f.candidate.statement); expect(row.sourceHash).toBe(f.source.contentHash);
  expect((await db.review_runs.get(f.run.id))!.external!.assessments[0].referenceClaim).toEqual(f.candidate);
  expect(fetchMock).not.toHaveBeenCalled();
  await expect(acceptExternalClaim(preview, db)).rejects.toThrow('이미');
  const retracted = await retractExternalClaim(row.id, '원문 해석 재검토', db);
  expect(retracted.retractedAt).not.toBeNull(); expect(retracted.retractionNote).toBe('원문 해석 재검토');
  expect((await db.external_claims.get(row.id))!.recordHash).toBe(await externalClaimHash(retracted));
  await expect(retractExternalClaim(row.id, 'again', db)).rejects.toThrow('이미');
});

it('invalidates preview after candidate, role, version or project policy changes', async () => {
  const f = await fixture(); const preview = await prepareExternalClaimAcceptance(f.run.id, f.pairId, db);
  const changed = structuredClone(f.run); changed.external!.assessments[0].referenceClaim!.statement = 'Different model statement';
  await db.review_runs.put(changed); await expect(acceptExternalClaim(preview, db)).rejects.toThrow('변경');
  await db.review_runs.put(f.run); await db.references.update(f.source.id, { role: 'note' });
  await expect(acceptExternalClaim(preview, db)).rejects.toThrow(); await db.references.update(f.source.id, { role: 'external' });
  await saveProjectSources(f.snapshot, null, [], db);
  await expect(acceptExternalClaim(preview, db)).rejects.toThrow();
  await saveProjectSources(f.snapshot, 1, [f.source.id], db);
  await saveTheoryVersion(f.snapshot.document.id, f.snapshot.version.id, { title: 'v2', markdown: 'A changed.', contract: f.snapshot.version.contract }, db);
  await expect(prepareExternalClaimAcceptance(f.run.id, f.pairId, db)).rejects.toThrow('오래된');
  expect(await db.external_claims.count()).toBe(0);
});

it('rolls back quota failures and permits exactly one concurrent acceptance', async () => {
  const f = await fixture(), preview = await prepareExternalClaimAcceptance(f.run.id, f.pairId, db);
  const fail = () => { throw new Error('quota'); }; db.external_claims.hook('creating', fail);
  await expect(acceptExternalClaim(preview, db)).rejects.toThrow('quota');
  db.external_claims.hook('creating').unsubscribe(fail); expect(await db.external_claims.count()).toBe(0);
  const outcomes = await Promise.allSettled([acceptExternalClaim(preview, db), acceptExternalClaim(preview, db)]);
  expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1); expect(await db.external_claims.count()).toBe(1);
});

it('restores accepted/retracted claims and rejects candidate/reference/hash forgery before replacing existing workspace', async () => {
  const f = await fixture(), row = await acceptExternalClaim(await prepareExternalClaimAcceptance(f.run.id, f.pairId, db), db);
  await retractExternalClaim(row.id, 'scope changed', db);
  const bundle = await createWorkspaceBundle(db); expect(bundle.version).toBe(22);
  await restoreWorkspaceBundle(bundle, target);
  const original = await target.external_claims.get(row.id); expect(original?.retractionNote).toBe('scope changed');
  for (const edit of [
    (copy: typeof bundle) => { copy.data.externalClaims[0].claim.evidenceQuote = 'invented'; },
    (copy: typeof bundle) => { copy.data.externalClaims[0].spanHash = '0'.repeat(64); },
    (copy: typeof bundle) => { copy.data.externalClaims[0].assessmentHash = '0'.repeat(64); }
  ]) {
    const bad = structuredClone(bundle); edit(bad);
    await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow();
    expect(await target.external_claims.get(row.id)).toEqual(original);
  }
});

it('imports v19 backup and upgrades a genuine populated v19 schema without inventing claim approvals', async () => {
  const f = await fixture(); const bundle = await createWorkspaceBundle(db);
  await restoreWorkspaceBundle({ ...bundle, version: 19 }, target);
  expect(await target.external_claims.count()).toBe(0);
  await target.delete(); const legacy = new Dexie(target.name);
  legacy.version(19).stores(Object.fromEntries(db.tables.filter(t => t.name !== 'external_claims').map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const table of db.tables.filter(t => t.name !== 'external_claims')) await legacy.table(table.name).bulkAdd(await table.toArray());
  legacy.close(); await target.open();
  expect(target.verno).toBe(23); expect(await target.external_claims.count()).toBe(0);
  expect(await target.document_versions.get(f.snapshot.version.id)).toEqual(f.snapshot.version);
});

it('shows only this project ledger and marks policy, source, version and retraction changes without promoting history', async () => {
  const a = await fixture(), b = await fixture();
  const first = await acceptExternalClaim(await prepareExternalClaimAcceptance(a.run.id, a.pairId, db), db);
  await acceptExternalClaim(await prepareExternalClaimAcceptance(b.run.id, b.pairId, db), db);
  let entries = await loadProjectExternalClaims(a.snapshot.document.projectId, db);
  expect(entries).toHaveLength(1); expect(entries[0].row.id).toBe(first.id); expect(entries[0].status).toBe('current');
  expect(entries[0].evidence.span.text).toContain('Independent positive result.');
  await saveProjectSources(a.snapshot, null, [a.source.id], db);
  expect((await loadProjectExternalClaims(a.snapshot.document.projectId, db))[0].status).toBe('policy_changed');
  await db.projects.update(a.snapshot.document.projectId, { sourcePolicy: undefined });
  await db.references.update(a.source.id, { role: 'note' });
  expect((await loadProjectExternalClaims(a.snapshot.document.projectId, db))[0].status).toBe('source_changed');
  await db.references.update(a.source.id, { role: 'external' });
  await db.references.update(a.source.id, { text: a.source.text + '\nAltered outside selected quote.' });
  expect((await loadProjectExternalClaims(a.snapshot.document.projectId, db))[0].status).toBe('source_changed');
  await db.references.update(a.source.id, { text: a.source.text });
  await saveTheoryVersion(a.snapshot.document.id, a.snapshot.version.id, { title: '새 정본', markdown: 'A changed.', contract: a.snapshot.version.contract }, db);
  expect((await loadProjectExternalClaims(a.snapshot.document.projectId, db))[0].status).toBe('version_stale');
  await retractExternalClaim(first.id, '해석 재검토', db);
  entries = await loadProjectExternalClaims(a.snapshot.document.projectId, db);
  expect(entries[0].status).toBe('retracted'); expect(entries[0].row.retractionNote).toBe('해석 재검토');
  expect((await loadProjectExternalClaims(b.snapshot.document.projectId, db)).map(e => e.row.id)).not.toContain(first.id);
});

it('keeps a moved document claim in the original project history without exposing it as current in the destination', async () => {
  const a = await fixture(), b = await fixture();
  await moveTheoryProject(b.snapshot, { projectId: a.snapshot.document.projectId, canonicalDocumentId: a.snapshot.document.id }, db);
  const adopted = await acceptExternalClaim(await prepareExternalClaimAcceptance(a.run.id, a.pairId, db), db);
  const c = await fixture();
  await moveTheoryProject(a.snapshot, { projectId: c.snapshot.document.projectId, canonicalDocumentId: c.snapshot.document.id }, db);
  const origin = await loadProjectExternalClaims(a.snapshot.document.projectId, db);
  expect(origin.find(e => e.row.id === adopted.id)?.status).toBe('document_moved');
  expect((await loadProjectExternalClaims(c.snapshot.document.projectId, db)).map(e => e.row.id)).not.toContain(adopted.id);
});

it('refuses to display a project ledger when a stored claim or frozen review context is tampered', async () => {
  const f = await fixture(), row = await acceptExternalClaim(await prepareExternalClaimAcceptance(f.run.id, f.pairId, db), db);
  await db.external_claims.update(row.id, { recordHash: '0'.repeat(64) });
  await expect(loadProjectExternalClaims(f.snapshot.document.projectId, db)).rejects.toThrow('hash');
  await db.external_claims.put(row);
  const altered = structuredClone(f.run); altered.external!.context.contextHash = '0'.repeat(64);
  await db.review_runs.put(altered);
  await expect(loadProjectExternalClaims(f.snapshot.document.projectId, db)).rejects.toThrow('hash');
});
