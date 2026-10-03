// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createTheory, saveTheoryVersion } from './documents';
import { EMPTY_CONTRACT } from './types';
import { runLocalReview, setClaimAcceptance, reviewSkeleton } from './reviews';
import { importReference } from '../retrieval/references';
import { prepareExternalReview, parseExternalResponse } from './externalReview';
import { prepareExternalRelation, approveExternalRelation, type ExternalRelationInput } from './externalRelation';
import { approveRelation, loadRelationWiki, retractRelation } from './relations';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { relationHash } from './relationValidation';
import { relationWikiToMarkdown } from './relationReport';
import { prepareReviewGraphContext } from './reviewGraph';
let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`adopt-${crypto.randomUUID()}`); target = new QaxiomDatabase(`adopt-target-${crypto.randomUUID()}`); });
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); await target.delete(); });
async function fixture() {
  const snapshot = await createTheory({ title: '채택 연결', markdown: 'A positive.\n\nB different.', contract: { ...EMPTY_CONTRACT, assumptions: 'A > 0' } }, db);
  const source = (await importReference('independent.md', 'Independent result.', 'external', db)).source;
  const span = (await db.reference_spans.where('sourceId').equals(source.id).first())!;
  const prepared = await prepareExternalReview(snapshot, [{ blockId: snapshot.blocks[0].id, spanId: span.id, theoryConditions: 'theory scope', referenceConditions: 'measured scope' }], db);
  const pairId = prepared.context.pairs[0].id;
  const parsed = parseExternalResponse(JSON.stringify({ checkedPairIds: [pairId], limitations: [], assessments: [{ pairId, label: 'different_scope', theoryQuote: 'A positive.', referenceQuote: 'Independent result.', theoryConditions: 'all A', referenceConditions: 'measured A', explanation: '범위 차이' }] }), prepared.context);
  const run = reviewSkeleton(snapshot, 'external-v1', [], 'mock');
  run.external = { context: prepared.context, checkedPairIds: parsed.checkedPairIds, assessments: parsed.assessments }; await db.review_runs.add(run);
  const local = await runLocalReview(snapshot, db);
  await setClaimAcceptance(local.id, local.claims[0].id, 'accepted', db);
  const input: ExternalRelationInput = { claimRunId: local.id, claimId: local.claims[0].id, kind: 'supports', label: 'compatible', theoryConditions: 'user common scope', referenceConditions: 'user reference scope', note: '원문과 공통 조건을 확인한 별도 사용자 승인' };
  return { snapshot, source, local, run, pairId, input };
}
it('requires a separate human proposal and persists model provenance without promoting internal checks', async () => {
  const f = await fixture(); const fetchMock = vi.spyOn(globalThis, 'fetch');
  const preview = await prepareExternalRelation(f.run.id, f.pairId, f.input, db);
  expect(await db.research_relations.count()).toBe(0);
  expect(preview.assessment.label).toBe('different_scope'); expect(preview.proposal.assessment!.label).toBe('compatible');
  const row = await approveExternalRelation(preview, db);
  expect(row.externalReviewOrigin!.runId).toBe(f.run.id); expect(row.to.quote).toBe('Independent result.');
  expect((await db.review_runs.get(f.run.id))!.checkedBlockIds).toEqual([]); expect((await db.review_runs.get(f.run.id))!.outcome).toBe('insufficient');
  expect(fetchMock).not.toHaveBeenCalled();
  const wiki = await loadRelationWiki(f.snapshot.document.id, db); expect(wiki.entries[0].status).toBe('active');
  expect(relationWikiToMarkdown(wiki)).toContain('외부 대조에서 별도 사용자 승인');
  expect((await prepareReviewGraphContext(f.snapshot, [f.snapshot.blocks[0].id], db)).graph.excludedCounts.external_not_selected).toBe(1);
});
it('rejects unchecked pairs, unaccepted/mismatching claims and incomplete human conditions', async () => {
  const f = await fixture();
  await expect(prepareExternalRelation(f.run.id, 'unknown', f.input, db)).rejects.toThrow('실제');
  await expect(prepareExternalRelation(f.run.id, f.pairId, { ...f.input, note: '' }, db)).rejects.toThrow('입력');
  await setClaimAcceptance(f.local.id, f.local.claims[1].id, 'accepted', db);
  await expect(prepareExternalRelation(f.run.id, f.pairId, { ...f.input, claimId: f.local.claims[1].id }, db)).rejects.toThrow('인용');
  await setClaimAcceptance(f.local.id, f.local.claims[0].id, 'rejected', db);
  await expect(prepareExternalRelation(f.run.id, f.pairId, f.input, db)).rejects.toThrow('채택');
});
it('invalidates preview on model result or claim acceptance changes', async () => {
  const f = await fixture(), preview = await prepareExternalRelation(f.run.id, f.pairId, f.input, db);
  const changed = structuredClone(f.run); changed.external!.assessments[0].label = 'compatible'; await db.review_runs.put(changed);
  await expect(approveExternalRelation(preview, db)).rejects.toThrow('변경');
  await db.review_runs.put(f.run); await setClaimAcceptance(f.local.id, f.local.claims[0].id, 'rejected', db);
  await expect(approveExternalRelation(preview, db)).rejects.toThrow('채택'); expect(await db.research_relations.count()).toBe(0);
});
it('rejects role changes and external sources that become own canonical documents', async () => {
  const f = await fixture(), preview = await prepareExternalRelation(f.run.id, f.pairId, f.input, db);
  await db.references.update(f.source.id, { role: 'note' }); await expect(approveExternalRelation(preview, db)).rejects.toThrow();
  await db.references.update(f.source.id, { role: 'external' });
  await createTheory({ title: '자체 재첨부', markdown: f.source.text, contract: EMPTY_CONTRACT }, db);
  await expect(approveExternalRelation(preview, db)).rejects.toThrow(); expect(await db.research_relations.count()).toBe(0);
});
it('rejects old versions and forged approval inputs', async () => {
  const f = await fixture(), preview = await prepareExternalRelation(f.run.id, f.pairId, f.input, db);
  const forged = structuredClone(preview); forged.input.theoryConditions = 'hidden changed condition';
  await expect(approveExternalRelation(forged, db)).rejects.toThrow('변경');
  await saveTheoryVersion(f.snapshot.document.id, f.snapshot.version.id, { title: 'new', markdown: 'A changed.', contract: EMPTY_CONTRACT }, db);
  await expect(approveExternalRelation(preview, db)).rejects.toThrow('오래된');
});
it('preserves retracted provenance through JSON backup and rejects broken origin or result hash atomically', async () => {
  const f = await fixture(), row = await approveExternalRelation(await prepareExternalRelation(f.run.id, f.pairId, f.input, db), db);
  await retractRelation(row.id, '사용자 철회', db);
  const bundle = await createWorkspaceBundle(db); expect(bundle.version).toBe(22);
  await restoreWorkspaceBundle(JSON.parse(JSON.stringify(bundle)), target);
  const restored = await target.research_relations.get(row.id); expect(restored!.externalReviewOrigin).toEqual(row.externalReviewOrigin);
  for (const edit of [
    (copy: typeof bundle) => { copy.data.researchRelations[0].externalReviewOrigin!.pairId = 'unknown'; },
    (copy: typeof bundle) => { copy.data.researchRelations[0].externalReviewOrigin!.assessmentHash = '0'.repeat(64); },
    (copy: typeof bundle) => { copy.data.reviewRuns.find(r => r.id === f.run.id)!.external!.assessments[0].explanation = 'tampered result'; }
  ]) {
    const bad = structuredClone(bundle); edit(bad); bad.data.researchRelations[0].relationHash = await relationHash(bad.data.researchRelations[0]);
    await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow(); expect(await target.research_relations.get(row.id)).toEqual(restored);
  }
});
it('rolls back failed storage and enforces atomic duplicate approval across tabs', async () => {
  const f = await fixture(), preview = await prepareExternalRelation(f.run.id, f.pairId, f.input, db);
  const fail = () => { throw new Error('quota'); }; db.research_relations.hook('creating', fail);
  await expect(approveExternalRelation(preview, db)).rejects.toThrow('quota'); db.research_relations.hook('creating').unsubscribe(fail);
  expect(await db.research_relations.count()).toBe(0);
  const results = await Promise.allSettled([approveExternalRelation(preview, db), approveExternalRelation(preview, db)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(await db.research_relations.count()).toBe(1);
});
it('upgrades genuine v15 schemas/backups without inventing external relation provenance', async () => {
  const f = await fixture(), preview = await prepareExternalRelation(f.run.id, f.pairId, f.input, db);
  const { externalReviewOrigin: _origin, ...plain } = preview.proposal; await approveRelation(plain, db);
  const bundle = await createWorkspaceBundle(db); await restoreWorkspaceBundle({ ...bundle, version: 15 }, target);
  expect((await target.research_relations.toArray())[0].externalReviewOrigin).toBeUndefined();
  await target.delete(); const legacy = new Dexie(target.name);
  legacy.version(15).stores(Object.fromEntries(db.tables.map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const t of db.tables) await legacy.table(t.name).bulkAdd(await t.toArray()); legacy.close(); await target.open();
  expect(target.verno).toBe(23); expect((await target.research_relations.toArray())[0].externalReviewOrigin).toBeUndefined();
});

it('prevents bypassing frozen-context hash checks through the generic relation approval API', async () => {
  const f = await fixture(), preview = await prepareExternalRelation(f.run.id, f.pairId, f.input, db);
  const corrupt = structuredClone(f.run); corrupt.external!.context.contextHash = '0'.repeat(64); await db.review_runs.put(corrupt);
  preview.proposal.externalReviewOrigin!.contextHash = corrupt.external!.context.contextHash;
  await expect(approveRelation(preview.proposal, db)).rejects.toThrow('hash'); expect(await db.research_relations.count()).toBe(0);
});
