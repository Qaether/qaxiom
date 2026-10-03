// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createTheory, saveTheoryVersion } from './documents';
import { EMPTY_CONTRACT } from './types';
import { runLocalReview, setClaimAcceptance, reviewSkeleton } from './reviews';
import { approveRelation, claimAnchor, retractRelation } from './relations';
import { prepareGraphReview } from './reviewGraph';
import { assertPlannedGraph, ensureCampaign, finishReviewAttempt, pendingBatches, planGraphReviewBatches, reserveReviewAttempt, saveReviewPlan } from './campaigns';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`graph-plan-${crypto.randomUUID()}`); target = new QaxiomDatabase(`graph-plan-target-${crypto.randomUUID()}`); });
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); await target.delete(); });
async function fixture(size = 9000, premiseSize = 1500) {
  const snapshot = await createTheory({ title: '공통 전제 분할', markdown: [`A ${'a'.repeat(premiseSize)}`, `B ${'b'.repeat(size)}`, `C ${'c'.repeat(size)}`].join('\n\n'), contract: { ...EMPTY_CONTRACT, assumptions: '모든 구간에서 반드시 유지하는 연구 기준' } }, db);
  const run = await runLocalReview(snapshot, db);
  for (const c of run.claims) { await setClaimAcceptance(run.id, c.id, 'accepted', db); c.acceptance = 'accepted'; }
  const [a, b, c] = run.claims.map(c => claimAnchor(run, c.id));
  const relations = [];
  for (const from of [b, c]) relations.push(await approveRelation({ documentId: snapshot.document.id, from, to: a, kind: 'depends_on', dependencyType: 'proof', assessment: null, note: '공통 필수 전제' }, db));
  return { snapshot, run, a, b, c, relations, campaign: await ensureCampaign(snapshot.document.id, db) };
}

it('splits on complete UTF-8 graph requests and repeats shared premises without provider calls', async () => {
  const { snapshot, a, b, c } = await fixture();
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  const plan = await planGraphReviewBatches(snapshot, [c.blockId, b.blockId], db);
  expect(plan.batches).toEqual([[b.blockId], [c.blockId]]);
  expect(plan.graphContexts.map(g => g.premiseBlockIds)).toEqual([[a.blockId], [a.blockId]]);
  expect(new Set(plan.graphContexts.map(g => g.graphFingerprint)).size).toBe(1);
  for (const ids of plan.batches) {
    const prepared = await prepareGraphReview(snapshot, ids, db);
    expect(new TextEncoder().encode(prepared.request).byteLength).toBeLessThanOrEqual(40000);
    expect(prepared.request).toContain(snapshot.version.contract.assumptions);
    const input = JSON.parse(prepared.request.split('원문이다:\n')[1]);
    expect(input.blocks.find((block: { id: string }) => block.id === a.blockId).quote).toBe(snapshot.blocks[0].text);
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

it('refuses an oversized mandatory closure while preserving the old plan and budget', async () => {
  const { snapshot, a, b, campaign } = await fixture(100, 23000);
  const old = await saveReviewPlan(campaign.id, snapshot, [b.blockId], db);
  await expect(saveReviewPlan(campaign.id, snapshot, [b.blockId], db, true)).rejects.toThrow('단일 요청');
  expect((await db.review_campaigns.get(campaign.id))!.plan).toEqual(old.plan);
  expect((await db.review_campaigns.get(campaign.id))!.attempts).toEqual([]);
  await expect(planGraphReviewBatches(snapshot, [], db)).rejects.toThrow('선택');
  await expect(planGraphReviewBatches(snapshot, [a.blockId, a.blockId], db)).rejects.toThrow('대상');
});

it('counts only actually checked graph targets, never attached or checked premises and other modes', async () => {
  const { snapshot, a, b, c, campaign } = await fixture();
  const saved = await saveReviewPlan(campaign.id, snapshot, [a.blockId, b.blockId, c.blockId], db, true);
  const prepared = await prepareGraphReview(snapshot, [b.blockId], db);
  const attempt = await reserveReviewAttempt(campaign.id, snapshot, prepared.blockIds, 'mock', db, prepared);
  const run = reviewSkeleton(snapshot, 'llm-v1', [a.blockId, b.blockId], 'mock');
  const finished = await finishReviewAttempt(campaign.id, attempt.token, run, db);
  expect(pendingBatches(finished, [run]).flat()).toEqual([a.blockId, c.blockId]);
  expect(pendingBatches(finished, [{ ...run, status: 'stopped' }]).flat()).toEqual(saved.plan!.batches.flat());
  expect(pendingBatches(finished, [{ ...run, graph: undefined }]).flat()).toEqual(saved.plan!.batches.flat());
  expect(pendingBatches(finished, [{ ...run, graph: { ...run.graph!, graphFingerprint: '0'.repeat(64) } }]).flat()).toEqual(saved.plan!.batches.flat());
});

it('retains proof cycle candidates without implying a successful consistency verdict', async () => {
  const { snapshot, a, b, campaign } = await fixture(10, 10);
  await approveRelation({ documentId: snapshot.document.id, from: a, to: b, kind: 'depends_on', dependencyType: 'proof', assessment: null, note: '순환 확인 대상' }, db);
  const saved = await saveReviewPlan(campaign.id, snapshot, [b.blockId], db, true);
  expect(saved.plan!.graphContexts![0].proofCycleRelationIds).toHaveLength(2);
  expect(saved.attempts).toEqual([]);
});

it('rejects changed approvals and canonical versions rather than silently using a saved scope', async () => {
  const { snapshot, b, relations, campaign } = await fixture(10, 10);
  const saved = await saveReviewPlan(campaign.id, snapshot, [b.blockId], db, true);
  const initial = await prepareGraphReview(snapshot, [b.blockId], db);
  expect(() => assertPlannedGraph(saved.plan, initial)).not.toThrow();
  await retractRelation(relations[0].id, '조건 변경', db);
  const fresh = await prepareGraphReview(snapshot, [b.blockId], db);
  expect(() => assertPlannedGraph(saved.plan, fresh)).toThrow('계획');
  await saveTheoryVersion(snapshot.document.id, snapshot.version.id, { title: '다음', markdown: '다음', contract: snapshot.version.contract }, db);
  await expect(saveReviewPlan(campaign.id, snapshot, [b.blockId], db, true)).rejects.toThrow('버전');
});

it('rejects state changes during split publication without replacing a valid old plan', async () => {
  const { snapshot, b, campaign } = await fixture(10, 10);
  const old = await saveReviewPlan(campaign.id, snapshot, [b.blockId], db);
  const spy = vi.spyOn(db.research_relations, 'where');
  const original = db.research_relations.where.bind(db.research_relations);
  let reads = 0;
  spy.mockImplementation(((...args: Parameters<typeof original>) => {
    reads++;
    if (reads === 3) throw new Error('분할 중 승인 그래프 변경 — 무결성 실패');
    return original(...args);
  }) as typeof original);
  await expect(saveReviewPlan(campaign.id, snapshot, [b.blockId], db, true)).rejects.toThrow('무결성');
  expect((await db.review_campaigns.get(campaign.id))!.plan).toEqual(old.plan);
});

it('round trips frozen plans after later retraction and rejects hash/scope/approval tampering atomically', async () => {
  const { snapshot, b, relations, campaign } = await fixture(10, 10);
  const saved = await saveReviewPlan(campaign.id, snapshot, [b.blockId], db, true);
  await retractRelation(relations[0].id, '나중에 철회', db);
  const bundle = await createWorkspaceBundle(db); expect(bundle.version).toBe(22);
  await restoreWorkspaceBundle(bundle, target);
  expect((await target.review_campaigns.get(campaign.id))!.plan).toEqual(saved.plan);
  for (const mutate of [
    (g: NonNullable<typeof saved.plan>['graphContexts']) => { g![0].contextHash = '0'.repeat(64); },
    (g: NonNullable<typeof saved.plan>['graphContexts']) => { g![0].premiseBlockIds = []; },
    (g: NonNullable<typeof saved.plan>['graphContexts']) => { g![0].relationSnapshots[0].note = '위조'; }
  ]) {
    const bad = structuredClone(bundle); mutate(bad.data.reviewCampaigns[0].plan!.graphContexts);
    await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow();
    expect((await target.review_campaigns.get(campaign.id))!.plan).toEqual(saved.plan);
  }
});

it('imports genuine v12 plans and upgrades populated v12 without inventing graph mode', async () => {
  const { snapshot, b, campaign } = await fixture(10, 10);
  await saveReviewPlan(campaign.id, snapshot, [b.blockId], db);
  const bundle = await createWorkspaceBundle(db);
  await restoreWorkspaceBundle({ ...bundle, version: 12 }, target);
  expect((await target.review_campaigns.get(campaign.id))!.plan!.graphContexts).toBeUndefined();
  await target.delete(); const legacy = new Dexie(target.name);
  legacy.version(12).stores(Object.fromEntries(db.tables.map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const t of db.tables) await legacy.table(t.name).bulkAdd(await t.toArray());
  legacy.close(); await target.open(); expect(target.verno).toBe(23);
  expect((await target.review_campaigns.get(campaign.id))!.plan).toEqual(bundle.data.reviewCampaigns[0].plan);
});
