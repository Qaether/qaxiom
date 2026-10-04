// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createTheory } from './documents';
import { EMPTY_CONTRACT } from './types';
import { runLocalReview, setClaimAcceptance, reviewSkeleton } from './reviews';
import { approveRelation, claimAnchor, retractRelation } from './relations';
import { prepareGraphReview, assertGraphReviewCurrent } from './reviewGraph';
import { ensureCampaign, reserveReviewAttempt, finishReviewAttempt } from './campaigns';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { importReference } from '../retrieval/references';
import { reviewToMarkdown } from './reviewReport';

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`graph-review-${crypto.randomUUID()}`); target = new QaxiomDatabase(`graph-target-${crypto.randomUUID()}`); });
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); await target.delete(); });
async function fixture() {
  const snapshot = await createTheory({ title: 'Graph', markdown: '# 가정\n\nA > 0.\n\n# 결과\n\nB > A.\n\n# 정의\n\nC is A.', contract: { ...EMPTY_CONTRACT } }, db);
  const run = await runLocalReview(snapshot, db);
  for (const c of run.claims) { await setClaimAcceptance(run.id, c.id, 'accepted', db); c.acceptance = 'accepted'; }
  const [a, b, c] = run.claims.map(c => claimAnchor(run, c.id));
  const relation = await approveRelation({ documentId: snapshot.document.id, from: b, to: a, kind: 'depends_on', dependencyType: 'proof', assessment: null, note: 'B needs A' }, db);
  await approveRelation({ documentId: snapshot.document.id, from: a, to: c, kind: 'defines', dependencyType: null, assessment: null, note: 'A uses C definition' }, db);
  return { snapshot, run, a, b, c, relation };
}
it('adds transitive approved premises but never sends unselected external sources or local state signatures', async () => {
  const { snapshot, b } = await fixture();
  const imported = await importReference('PRIVATE-name.md', 'PRIVATE external quote.', 'external', db);
  const span = (await db.reference_spans.where('sourceId').equals(imported.source.id).first())!;
  await approveRelation({ documentId: snapshot.document.id, from: b, to: { type: 'reference', sourceId: imported.source.id, sourceHash: imported.source.contentHash, spanId: span.id, spanHash: span.contentHash, quote: span.text }, kind: 'supports', dependencyType: null, note: 'PRIVATE note', assessment: { label: 'compatible', theoryConditions: 'PRIVATE scope', referenceConditions: 'PRIVATE conditions' } }, db);
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  const prepared = await prepareGraphReview(snapshot, [b.blockId], db);
  expect(prepared.graph.targetBlockIds).toEqual([b.blockId]); expect(prepared.graph.premiseBlockIds).toHaveLength(2);
  expect(prepared.graph.relationSnapshots).toHaveLength(2); expect(prepared.graph.excludedCounts.external_not_selected).toBe(1);
  expect(prepared.request).not.toContain('PRIVATE'); expect(prepared.request).not.toContain('stateSignature'); expect(fetchMock).not.toHaveBeenCalled();
  expect((await prepareGraphReview(snapshot, [b.blockId], db)).graph).toEqual(prepared.graph);
});
it('rejects obsolete preview before charging an attempt and excludes revoked claims and retracted edges', async () => {
  const { snapshot, b, relation, run, a } = await fixture(); const campaign = await ensureCampaign(snapshot.document.id, db);
  const prepared = await prepareGraphReview(snapshot, [b.blockId], db);
  await setClaimAcceptance(run.id, a.claimId, 'rejected', db);
  await expect(reserveReviewAttempt(campaign.id, snapshot, prepared.blockIds, 'mock', db, prepared)).rejects.toThrow('변경');
  expect((await db.review_campaigns.get(campaign.id))!.attempts).toHaveLength(0);
  const revoked = await prepareGraphReview(snapshot, [b.blockId], db); expect(revoked.graph.premiseBlockIds).toEqual([]); expect(revoked.graph.excludedCounts.claim_unaccepted).toBe(2);
  await retractRelation(relation.id, 'No longer used', db);
  expect((await prepareGraphReview(snapshot, [b.blockId], db)).graph.excludedCounts.retracted).toBe(1);
  await expect(assertGraphReviewCurrent(snapshot, prepared, db)).rejects.toThrow('변경');
});
it('records actual checked scope separately, keeps frozen approvals after retraction and round trips v10', async () => {
  const { snapshot, b, relation } = await fixture(); const prepared = await prepareGraphReview(snapshot, [b.blockId], db);
  const campaign = await ensureCampaign(snapshot.document.id, db);
  const attempt = await reserveReviewAttempt(campaign.id, snapshot, prepared.blockIds, 'mock', db, prepared);
  const run = reviewSkeleton(snapshot, 'llm-v1', [b.blockId], 'mock'); run.outcome = 'insufficient';
  await finishReviewAttempt(campaign.id, attempt.token, run, db);
  expect(run.checkedBlockIds).toEqual([b.blockId]); expect(run.graph).toEqual(prepared.graph);
  await retractRelation(relation.id, 'Later retraction', db);
  const bundle = await createWorkspaceBundle(db); expect(bundle.version).toBe(24); await restoreWorkspaceBundle(bundle, target);
  expect((await target.review_runs.get(run.id))!.graph).toEqual(prepared.graph);
  expect(reviewToMarkdown(run, snapshot.version, snapshot.blocks)).toContain(prepared.graph.contextHash);
  const tampered = structuredClone(bundle); tampered.data.reviewRuns.find(r => r.id === run.id)!.graph!.contextHash = '0'.repeat(64);
  await expect(restoreWorkspaceBundle(tampered, target)).rejects.toThrow(); expect((await target.review_runs.get(run.id))!.graph).toEqual(prepared.graph);
});
it('does not publish successful model results when graph changes after transmission', async () => {
  const { snapshot, b, relation } = await fixture(); const prepared = await prepareGraphReview(snapshot, [b.blockId], db);
  const campaign = await ensureCampaign(snapshot.document.id, db);
  const attempt = await reserveReviewAttempt(campaign.id, snapshot, prepared.blockIds, 'mock', db, prepared);
  await retractRelation(relation.id, 'Changed during request', db);
  const run = reviewSkeleton(snapshot, 'llm-v1', prepared.blockIds, 'mock');
  await finishReviewAttempt(campaign.id, attempt.token, run, db);
  expect(run.status).toBe('failed'); expect(run.checkedBlockIds).toEqual([]); expect(run.graph).toEqual(prepared.graph);
  expect(run.error).toContain('비용'); await restoreWorkspaceBundle(await createWorkspaceBundle(db), target);
});
it('restores in-flight graph attempts as stopped without resending and preserves reserved budget', async () => {
  const { snapshot, b } = await fixture(); const prepared = await prepareGraphReview(snapshot, [b.blockId], db);
  const campaign = await ensureCampaign(snapshot.document.id, db);
  await reserveReviewAttempt(campaign.id, snapshot, prepared.blockIds, 'mock', db, prepared);
  const fetchMock = vi.spyOn(globalThis, 'fetch'); await restoreWorkspaceBundle(await createWorkspaceBundle(db), target);
  const restored = (await target.review_campaigns.get(campaign.id))!.attempts[0];
  expect(restored.elapsedMs).toBe(120000); const run = (await target.review_runs.get(restored.runId!))!;
  expect(run.status).toBe('stopped'); expect(run.graph).toEqual(prepared.graph); expect(fetchMock).not.toHaveBeenCalled();
  await restoreWorkspaceBundle(await createWorkspaceBundle(target), db);
});
it('imports genuine v9 backups and upgrades populated v9 without inventing graph contexts', async () => {
  const { snapshot } = await fixture(); const bundle = await createWorkspaceBundle(db);
  await restoreWorkspaceBundle({ ...bundle, version: 9 }, target); expect((await target.review_runs.toArray()).every(r => !r.graph)).toBe(true);
  await target.delete(); const legacy = new Dexie(target.name);
  legacy.version(9).stores(Object.fromEntries(db.tables.map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const t of db.tables) await legacy.table(t.name).bulkAdd(await t.toArray());
  legacy.close(); await target.open(); expect(target.verno).toBe(25); expect(await target.document_versions.get(snapshot.version.id)).toEqual(snapshot.version);
});
it('previews long mandatory premises without truncation, transmission or budget reservation', async () => {
  const snapshot = await createTheory({ title: 'Large graph', markdown: `# 가정\n\nA ${'x'.repeat(23000)}\n\n# 결과\n\nB needs A.`, contract: { ...EMPTY_CONTRACT } }, db);
  const run = await runLocalReview(snapshot, db);
  for (const c of run.claims) { await setClaimAcceptance(run.id, c.id, 'accepted', db); c.acceptance = 'accepted'; }
  const [a, b] = run.claims.map(c => claimAnchor(run, c.id));
  await approveRelation({ documentId: snapshot.document.id, from: b, to: a, kind: 'depends_on', dependencyType: 'proof', assessment: null, note: 'Mandatory large premise' }, db);
  const campaign = await ensureCampaign(snapshot.document.id, db); const fetchMock = vi.spyOn(globalThis, 'fetch');
  const prepared = await prepareGraphReview(snapshot, [b.blockId], db);
  expect(new TextEncoder().encode(prepared.request).byteLength).toBeGreaterThan(40000);
  expect(prepared.request).toContain('x'.repeat(23000));
  expect((await db.review_campaigns.get(campaign.id))!.attempts).toEqual([]); expect(fetchMock).not.toHaveBeenCalled();
});
it('rejects forged premise scopes, approval snapshots and attempt/run divergence before replacing data', async () => {
  const { snapshot, b } = await fixture(); const prepared = await prepareGraphReview(snapshot, [b.blockId], db);
  const campaign = await ensureCampaign(snapshot.document.id, db);
  const attempt = await reserveReviewAttempt(campaign.id, snapshot, prepared.blockIds, 'mock', db, prepared);
  const run = reviewSkeleton(snapshot, 'llm-v1', [], 'mock'); run.status = 'failed'; run.outcome = 'insufficient';
  await finishReviewAttempt(campaign.id, attempt.token, run, db);
  const bundle = await createWorkspaceBundle(db); await restoreWorkspaceBundle(bundle, target);
  const before = (await createWorkspaceBundle(target)).data;
  for (const mutate of [
    (v: typeof bundle) => { v.data.reviewRuns.find(r => r.id === run.id)!.graph!.premiseBlockIds = []; },
    (v: typeof bundle) => { v.data.reviewCampaigns[0].attempts[0].graph!.excludedCounts.outside_scope++; },
    (v: typeof bundle) => { v.data.reviewRuns.find(r => r.id === run.id)!.graph!.relationSnapshots[0].from.quote = 'fabricated'; }
  ]) {
    const bad = structuredClone(bundle); mutate(bad); await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow();
    expect((await createWorkspaceBundle(target)).data).toEqual(before);
  }
});
it('keeps declared proof cycles as limitations even if a complete model response reports no issues', async () => {
  const { snapshot, a, b } = await fixture();
  await approveRelation({ documentId: snapshot.document.id, from: a, to: b, kind: 'depends_on', dependencyType: 'proof', assessment: null, note: 'Explicit reverse proof edge' }, db);
  const prepared = await prepareGraphReview(snapshot, snapshot.blocks.map(b => b.id), db);
  expect(prepared.graph.proofCycleRelationIds).toHaveLength(2);
  const campaign = await ensureCampaign(snapshot.document.id, db);
  const attempt = await reserveReviewAttempt(campaign.id, snapshot, prepared.blockIds, 'mock', db, prepared);
  const run = reviewSkeleton(snapshot, 'llm-v1', prepared.blockIds, 'mock');
  await finishReviewAttempt(campaign.id, attempt.token, run, db);
  expect(run.status).toBe('complete'); expect(run.outcome).toBe('insufficient'); expect(run.limitations.join(' ')).toContain('순환 후보');
  await restoreWorkspaceBundle(await createWorkspaceBundle(db), target);
  const bad = await createWorkspaceBundle(db); const altered = bad.data.reviewRuns.find(r => r.id === run.id)!;
  altered.limitations = []; altered.outcome = 'scope_passed';
  await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow();
});
it('rejects a modified prepared graph even if its original request and digest remain unchanged', async () => {
  const { snapshot, b } = await fixture(); const prepared = await prepareGraphReview(snapshot, [b.blockId], db);
  const campaign = await ensureCampaign(snapshot.document.id, db);
  const bad = structuredClone(prepared); bad.graph.relationSnapshots[0].note = 'Modified unpublished payload';
  await expect(reserveReviewAttempt(campaign.id, snapshot, bad.blockIds, 'mock', db, bad)).rejects.toThrow('변경');
  const badScope = structuredClone(prepared); badScope.blockIds = [b.blockId];
  await expect(assertGraphReviewCurrent(snapshot, badScope, db)).rejects.toThrow('변경');
  expect((await db.review_campaigns.get(campaign.id))!.attempts).toHaveLength(0);
});
