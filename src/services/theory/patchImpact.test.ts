// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createTheory, loadTheory, saveTheoryVersion } from './documents';
import { EMPTY_CONTRACT } from './types';
import { applyTheoryPatch, parseModelReview, runLocalReview, setClaimAcceptance, resolveReviewIssue } from './reviews';
import { approveRelation, claimAnchor, retractRelation } from './relations';
import { currentPatchImpactScope, preparePatchImpact } from './patchImpact';
import { prepareGraphReview } from './reviewGraph';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { importReference } from '../retrieval/references';
import { reviewToMarkdown } from './reviewReport';
import { prepareUndeclaredImpact, selectUndeclaredImpact } from './undeclaredImpact';
import { rankUndeclaredImpact } from './impactRanking';

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`patch-impact-${crypto.randomUUID()}`); target = new QaxiomDatabase(`patch-impact-target-${crypto.randomUUID()}`); });
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); await target.delete(); });
async function fixture(assumptions = '', replacement = 'A revised.\n\n') {
  const snapshot = await createTheory({ title: '수정 영향', markdown: ['A original.', 'B defines A.', 'C needs B and E.', 'D supports B.', 'E independent premise.', 'F unrelated.'].join('\n\n'), contract: { ...EMPTY_CONTRACT } }, db);
  const local = await runLocalReview(snapshot, db);
  for (const c of local.claims) { await setClaimAcceptance(local.id, c.id, 'accepted', db); c.acceptance = 'accepted'; }
  const [a, b, c, d, e, f] = local.claims.map(c => claimAnchor(local, c.id));
  const relations = [];
  for (const [from, to, kind] of [[b, a, 'defines'], [c, b, 'depends_on'], [c, e, 'depends_on'], [d, b, 'supports']] as const) {
    relations.push(await approveRelation({ documentId: snapshot.document.id, from, to, kind, dependencyType: kind === 'depends_on' ? 'proof' : null, assessment: null, note: '명시 승인 관계' }, db));
  }
  const run = parseModelReview(JSON.stringify({ checkedBlockIds: snapshot.blocks.map(b => b.id), limitations: [], claims: [],
    issues: [{ kind: 'argument', severity: 'warning', blockIds: [a.blockId], quotes: ['A original.'], explanation: 'A 수정 후보', resolution: '영향 범위 재검사', patch: { blockId: a.blockId, replacement, introducedAssumptions: assumptions } }] }), snapshot, snapshot.blocks.map(b => b.id), 'mock');
  await db.review_runs.add(run);
  return { snapshot, local, a, b, c, d, e, f, relations, run, patch: run.patches[0] };
}

it('includes reverse definition/dependencies and compatibility peers plus mandatory premises, not unrelated sources', async () => {
  const { snapshot, a, b, c, d, e, f, run, patch } = await fixture();
  const source = await importReference('PRIVATE-reference.md', 'PRIVATE original', 'external', db);
  const span = (await db.reference_spans.where('sourceId').equals(source.source.id).first())!;
  await approveRelation({ documentId: snapshot.document.id, from: a, to: { type: 'reference', sourceId: source.source.id, sourceHash: source.source.contentHash, spanId: span.id, spanHash: span.contentHash, quote: span.text }, kind: 'supports', dependencyType: null, note: 'PRIVATE external approval', assessment: { label: 'compatible', theoryConditions: 'PRIVATE scope', referenceConditions: 'PRIVATE conditions' } }, db);
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  const { impact } = await preparePatchImpact(run.id, patch.id, db);
  expect(impact.graph.targetBlockIds).toEqual([a.blockId, b.blockId, c.blockId, d.blockId]);
  expect(impact.graph.premiseBlockIds).toEqual([e.blockId]);
  expect(impact.graph.targetBlockIds).not.toContain(f.blockId);
  expect(JSON.stringify(impact)).not.toContain('PRIVATE'); expect(impact.graph.excludedCounts.external_not_selected).toBe(1);
  expect(impact.graph.versionId).toBe(snapshot.version.id); expect(fetchMock).not.toHaveBeenCalled();
});

it('requires fresh approved scope before atomic apply and leaves rejected/retired edges out', async () => {
  const { snapshot, run, patch, relations, local, b } = await fixture();
  const preview = await preparePatchImpact(run.id, patch.id, db);
  await retractRelation(relations[0].id, '정의 연결 철회', db);
  await expect(applyTheoryPatch(run.id, patch.id, db, preview.impact)).rejects.toThrow('변경');
  expect((await loadTheory(snapshot.document.id, db)).version.id).toBe(snapshot.version.id);
  expect((await db.review_runs.get(run.id))!.patches[0].appliedVersionId).toBeNull();
  await setClaimAcceptance(local.id, b.claimId, 'rejected', db);
  const fresh = await preparePatchImpact(run.id, patch.id, db);
  expect(fresh.impact.graph.targetBlockIds).toEqual([patch.blockId]);
});

it('rejects replacement changes after preview even when the graph and contract-change flag stay unchanged', async () => {
  const { snapshot, run, patch } = await fixture();
  const preview = await preparePatchImpact(run.id, patch.id, db);
  await db.review_runs.update(run.id, { patches: [{ ...patch, replacement: 'A different proposal.\n\n' }] });
  await expect(applyTheoryPatch(run.id, patch.id, db, preview.impact)).rejects.toThrow('변경');
  expect((await loadTheory(snapshot.document.id, db)).version.id).toBe(snapshot.version.id);
});

it('persists frozen impact with new version without transferring past approvals and keeps issue unresolved', async () => {
  const { run, patch, snapshot, f } = await fixture();
  const preview = await preparePatchImpact(run.id, patch.id, db);
  const saved = await applyTheoryPatch(run.id, patch.id, db, preview.impact);
  const stored = (await db.review_runs.get(run.id))!;
  expect(stored.patches[0].impact).toEqual(preview.impact); expect(stored.issues[0].resolvedByRunId).toBeNull();
  const scope = await currentPatchImpactScope(run.id, patch.id, saved, db);
  expect(scope.blockIds).toHaveLength(5); expect(scope.blockIds).not.toContain(f.blockId); expect(scope.fullScope).toBe(false);
  const currentGraph = await prepareGraphReview(saved, scope.blockIds, db);
  expect(currentGraph.graph.relationSnapshots).toEqual([]); expect(currentGraph.graph.excludedCounts.stale).toBe(4);
  expect(reviewToMarkdown(stored, snapshot.version, snapshot.blocks)).toContain('수정 영향 범위');
});

it('expands new assumptions to the whole document even when only one block changes', async () => {
  const { snapshot, run, patch } = await fixture('새 가정 A > 0');
  const prepared = await preparePatchImpact(run.id, patch.id, db);
  expect(prepared.impact.contractChanged).toBe(true);
  expect(prepared.impact.graph.targetBlockIds).toEqual(snapshot.blocks.map(b => b.id));
  const saved = await applyTheoryPatch(run.id, patch.id, db, prepared.impact);
  expect((await currentPatchImpactScope(run.id, patch.id, saved, db)).blockIds).toEqual(saved.blocks.map(b => b.id));
});

it('maps split/merged lineages and later edits; removed scope falls back to full current document', async () => {
  const { run, patch } = await fixture('', 'A revised part one.\n\nA revised part two.\n\n');
  const saved = await applyTheoryPatch(run.id, patch.id, db);
  const scope = await currentPatchImpactScope(run.id, patch.id, saved, db);
  expect(scope.blockIds).toHaveLength(6); expect(scope.fullScope).toBe(false);
  const merged = await saveTheoryVersion(saved.document.id, saved.version.id, { title: saved.version.title, markdown: 'A B C D E merged.\n\nF unrelated.', contract: saved.version.contract }, db);
  const mergedScope = await currentPatchImpactScope(run.id, patch.id, merged, db);
  expect(mergedScope.blockIds).toEqual([merged.blocks[0].id]); expect(mergedScope.fullScope).toBe(false);
  const removed = await saveTheoryVersion(saved.document.id, merged.version.id, { title: saved.version.title, markdown: 'F unrelated.', contract: saved.version.contract }, db);
  const final = await currentPatchImpactScope(run.id, patch.id, removed, db);
  expect(final.lostLineage).toBe(true); expect(final.blockIds).toEqual(removed.blocks.map(b => b.id));
});

it('uses local inspection without a provider budget, while oversized recheck requests still reject truncation', async () => {
  const { snapshot, run, patch } = await fixture('', 'A revised.\n\n');
  const large = { ...run.patches[0], replacement: 'A '.repeat(25000) };
  await db.review_runs.update(run.id, { patches: [large] });
  const prepared = await preparePatchImpact(run.id, patch.id, db);
  const saved = await applyTheoryPatch(run.id, patch.id, db, prepared.impact);
  const scope = await currentPatchImpactScope(run.id, patch.id, saved, db);
  await expect(prepareGraphReview(saved, scope.blockIds, db)).rejects.toThrow('40 KB');
  expect(saved.version.parentVersionId).toBe(snapshot.version.id);
});

it('rolls back both impact approval and version creation on storage failure', async () => {
  const { snapshot, run, patch } = await fixture();
  const fail = () => { throw new Error('quota'); }; db.review_runs.hook('updating', fail);
  await expect(applyTheoryPatch(run.id, patch.id, db)).rejects.toThrow('quota');
  db.review_runs.hook('updating').unsubscribe(fail);
  expect((await loadTheory(snapshot.document.id, db)).version.id).toBe(snapshot.version.id);
  expect((await db.review_runs.get(run.id))!.patches[0].impact).toBeUndefined(); expect(await db.document_versions.count()).toBe(1);
});

it('restores historical impact after retraction and rejects scope/hash/provenance corruption atomically', async () => {
  const { run, patch, relations } = await fixture(); const saved = await applyTheoryPatch(run.id, patch.id, db);
  await retractRelation(relations[0].id, '나중에 철회', db);
  const bundle = await createWorkspaceBundle(db); expect(bundle.version).toBe(22); await restoreWorkspaceBundle(bundle, target);
  const restored = (await target.review_runs.get(run.id))!;
  expect((await currentPatchImpactScope(run.id, patch.id, await loadTheory(saved.document.id, target), target)).blockIds).toHaveLength(5);
  for (const edit of [
    (copy: typeof bundle) => { copy.data.reviewRuns.find(r => r.id === run.id)!.patches[0].impact!.graph.contextHash = '0'.repeat(64); },
    (copy: typeof bundle) => { copy.data.reviewRuns.find(r => r.id === run.id)!.patches[0].impact!.patchHash = '0'.repeat(64); },
    (copy: typeof bundle) => { copy.data.reviewRuns.find(r => r.id === run.id)!.patches[0].impact!.contractChanged = true; },
    (copy: typeof bundle) => { copy.data.reviewRuns.find(r => r.id === run.id)!.patches[0].impact!.graph.targetBlockIds.pop(); }
  ]) {
    const bad = structuredClone(bundle); edit(bad); await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow();
    expect(await target.review_runs.get(run.id)).toEqual(restored);
  }
});

it('keeps partial reinspection from resolving an issue and rejects unrelated document scope', async () => {
  const { run, patch } = await fixture(); const saved = await applyTheoryPatch(run.id, patch.id, db);
  const scope = await currentPatchImpactScope(run.id, patch.id, saved, db);
  const recheck = parseModelReview(JSON.stringify({ checkedBlockIds: scope.blockIds, limitations: [], claims: [], issues: [] }), saved, scope.blockIds, 'mock');
  await db.review_runs.add(recheck); expect(recheck.outcome).toBe('insufficient');
  await expect(resolveReviewIssue(run.id, run.issues[0].id, recheck.id, db)).rejects.toThrow('전체 범위');
  const other = await createTheory({ title: '다른', markdown: '다른', contract: EMPTY_CONTRACT }, db);
  await expect(currentPatchImpactScope(run.id, patch.id, other, db)).rejects.toThrow('이력');
});

it('imports genuine v13 applied patches and upgrades populated v13 without fabricating impact evidence', async () => {
  const { run, patch } = await fixture(); await applyTheoryPatch(run.id, patch.id, db);
  const stored = (await db.review_runs.get(run.id))!; delete stored.patches[0].impact; await db.review_runs.put(stored);
  const bundle = await createWorkspaceBundle(db); await restoreWorkspaceBundle({ ...bundle, version: 13 }, target);
  expect((await target.review_runs.get(run.id))!.patches[0].impact).toBeUndefined();
  await target.delete(); const legacy = new Dexie(target.name);
  legacy.version(13).stores(Object.fromEntries(db.tables.map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const t of db.tables) await legacy.table(t.name).bulkAdd(await t.toArray());
  legacy.close(); await target.open(); expect(target.verno).toBe(23);
  expect((await target.review_runs.get(run.id))!.patches[0].impact).toBeUndefined();
});

it('nominates undeclared removed/added terms outside approved scope without sending or approving anything', async () => {
  const { run, patch, f, relations } = await fixture('', 'A revised F.\n\n');
  const saved = await applyTheoryPatch(run.id, patch.id, db);
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  const prepared = await prepareUndeclaredImpact(run.id, patch.id, saved, db);
  expect(prepared.ranking.matches.map(m => m.blockId)).toEqual([f.blockId]);
  expect(prepared.ranking.matches[0].added).toContain('f');
  expect(prepared.scopeBlockIds).toHaveLength(5);
  expect(await selectUndeclaredImpact(run.id, patch.id, saved, prepared, [f.blockId], db)).toEqual(saved.blocks.map(b => b.id));
  expect(fetchMock).not.toHaveBeenCalled(); expect(await db.research_relations.count()).toBe(relations.length);
  expect((await db.review_runs.get(run.id))!.issues[0].resolvedByRunId).toBeNull();
  await expect(selectUndeclaredImpact(run.id, patch.id, saved, prepared, [], db)).rejects.toThrow('명시');
  await expect(selectUndeclaredImpact(run.id, patch.id, saved, prepared, [f.blockId, f.blockId], db)).rejects.toThrow('명시');
  await expect(selectUndeclaredImpact(run.id, patch.id, saved, prepared, [saved.blocks[0].id], db)).rejects.toThrow('명시');
});

it('rejects stale/forged nominations and original block corruption before selection', async () => {
  const { run, patch, f, relations } = await fixture('', 'A revised F.\n\n');
  const saved = await applyTheoryPatch(run.id, patch.id, db);
  const prepared = await prepareUndeclaredImpact(run.id, patch.id, saved, db);
  const forged = structuredClone(prepared); forged.ranking.matches[0].added = ['fabricated'];
  await expect(selectUndeclaredImpact(run.id, patch.id, saved, forged, [f.blockId], db)).rejects.toThrow('변경');
  await retractRelation(relations[0].id, '선택 전 철회', db);
  await expect(selectUndeclaredImpact(run.id, patch.id, saved, prepared, [f.blockId], db)).rejects.toThrow('변경');
  const original = await db.document_blocks.where('versionId').equals(run.versionId).first();
  await db.document_blocks.put({ ...original!, text: 'CORRUPT' });
  await expect(prepareUndeclaredImpact(run.id, patch.id, saved, db)).rejects.toThrow('hash');
});

it('rejects mutation during Worker ranking and remains local on full-scope or no-match searches', async () => {
  const { run, patch, relations } = await fixture('', 'A revised F.\n\n');
  const saved = await applyTheoryPatch(run.id, patch.id, db);
  await expect(prepareUndeclaredImpact(run.id, patch.id, saved, db, async input => {
    await retractRelation(relations[0].id, '검색 중 철회', db); return rankUndeclaredImpact(input);
  })).rejects.toThrow('검색 중');
  const whole = await fixture('전체 범위 가정');
  const full = await applyTheoryPatch(whole.run.id, whole.patch.id, db);
  const prepared = await prepareUndeclaredImpact(whole.run.id, whole.patch.id, full, db);
  expect(prepared.fullScope).toBe(true); expect(prepared.ranking.scannedBlockCount).toBe(0); expect(prepared.ranking.matches).toEqual([]);
  const noMatch = await fixture(); const unchanged = await applyTheoryPatch(noMatch.run.id, noMatch.patch.id, db);
  expect((await prepareUndeclaredImpact(noMatch.run.id, noMatch.patch.id, unchanged, db)).ranking.matches).toEqual([]);
});
