// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QaxiomDatabase } from '../database';
import { createTheory, saveTheoryVersion } from '../theory/documents';
import { EMPTY_CONTRACT } from '../theory/types';
import { seedLegacyPolicy as saveProjectSources, seedLegacyProjectMove as moveTheoryProject } from '../theory/legacyProjectFixtures';
import { createEmbeddingSpace, indexEmbeddingPlan, prepareEmbeddingPlan } from './embeddings';
import { assertEmbeddingScopeCurrent, captureEmbeddingScope } from './embeddingScope';
import { importReference } from './references';

let db: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`embedding-policy-${crypto.randomUUID()}`); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await db.delete(); });
const vector = () => Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0);
const fake = (onRequest?: () => Promise<void>) => {
  const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
    await onRequest?.();
    const input = JSON.parse(init.body as string).input as string[];
    return new Response(JSON.stringify({ model: 'text-embedding-3-small', data: input.map((_, index) => ({ index, embedding: vector() })) }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock); return fetchMock;
};
async function fixture() {
  const snapshot = await createTheory({ title: 'Embedding policy', markdown: 'A positive.', contract: EMPTY_CONTRACT }, db);
  const a = (await importReference('a.md', 'selected needle evidence.', 'external', db)).source;
  const b = (await importReference('PRIVATE.md', 'PRIVATE original.', 'external', db)).source;
  const space = await createEmbeddingSpace(db);
  return { snapshot, a, b, space };
}
it('rejects an out-of-policy source before preparing text and excludes other allowed source IDs from request', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id], db, 'research');
  const fetchMock = fake();
  await expect(prepareEmbeddingPlan(f.space.id, [f.a.id, f.b.id], 3, db, f.snapshot.version.id)).rejects.toThrow('허용 목록');
  const plan = await prepareEmbeddingPlan(f.space.id, [f.a.id], 3, db, f.snapshot.version.id);
  expect(plan.projectScope?.policyScope).toBe('research'); expect(plan.projectScope?.sourceIds).toEqual([f.a.id]);
  await indexEmbeddingPlan(plan, 'mock-key', new AbortController().signal, () => {}, db);
  expect(fetchMock).toHaveBeenCalledOnce();
  const body = fetchMock.mock.calls[0][1].body as string;
  expect(body).toContain('selected needle'); expect(body).not.toContain('PRIVATE'); expect(body).not.toContain(f.b.id);
});
it('denies an old preview even if the same source remains permitted, before any API request', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id], db, 'research');
  const plan = await prepareEmbeddingPlan(f.space.id, [f.a.id], 3, db, f.snapshot.version.id), fetchMock = fake();
  await saveProjectSources(f.snapshot, 1, [f.a.id, f.b.id], db, 'research');
  await expect(indexEmbeddingPlan(plan, 'key', new AbortController().signal, () => {}, db)).rejects.toThrow('변경');
  expect(fetchMock).not.toHaveBeenCalled(); expect(await db.embedding_vectors.count()).toBe(0);
});
it('does not publish a vector from an in-flight request after policy revocation', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id], db, 'research');
  const plan = await prepareEmbeddingPlan(f.space.id, [f.a.id], 3, db, f.snapshot.version.id);
  const fetchMock = fake(async () => { await saveProjectSources(f.snapshot, 1, [], db, 'research'); });
  await expect(indexEmbeddingPlan(plan, 'key', new AbortController().signal, () => {}, db)).rejects.toThrow('허용 목록');
  expect(fetchMock).toHaveBeenCalledOnce(); expect(await db.embedding_vectors.count()).toBe(0);
  expect((await db.embedding_spaces.get(f.space.id))?.runId).toBeNull();
});
it('stops the next batch when a policy changes after an already saved checkpoint', async () => {
  const f = await fixture();
  const big = (await importReference('many.md', '가'.repeat(2400 * 20), 'external', db)).source;
  await saveProjectSources(f.snapshot, null, [big.id], db, 'research');
  const plan = await prepareEmbeddingPlan(f.space.id, [big.id], 3, db, f.snapshot.version.id);
  expect(plan.batches.length).toBeGreaterThan(1);
  let requests = 0;
  const fetchMock = fake(async () => { if (++requests === 2) await saveProjectSources(f.snapshot, 1, [], db, 'research'); });
  await expect(indexEmbeddingPlan(plan, 'key', new AbortController().signal, () => {}, db)).rejects.toThrow('허용 목록');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(await db.embedding_vectors.count()).toBe(plan.batches[0].length);
  await expect(assertEmbeddingScopeCurrent(plan.projectScope!, [big.id], db)).rejects.toThrow('허용 목록');
});
it('binds preview to current document project/version while preserving legacy external-only scope', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [], db);
  const legacy = await captureEmbeddingScope(f.snapshot.version.id, [f.a.id], db);
  expect(legacy?.policyScope).toBe('external_review'); await assertEmbeddingScopeCurrent(legacy, [f.a.id], db);
  const moved = await moveTheoryProject(f.snapshot, { newTitle: 'Another' }, db);
  await expect(assertEmbeddingScopeCurrent(legacy, [f.a.id], db)).rejects.toThrow('변경');
  const current = await captureEmbeddingScope(moved.version.id, [f.a.id], db);
  await saveTheoryVersion(moved.document.id, moved.version.id, { title: 'Embedding policy', markdown: 'A changed.', contract: EMPTY_CONTRACT }, db);
  await expect(assertEmbeddingScopeCurrent(current, [f.a.id], db)).rejects.toThrow('변경');
});
it('binds project-only embedding previews to the project policy without a canonical version', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id], db, 'research');
  await expect(prepareEmbeddingPlan(f.space.id, [f.a.id, f.b.id], 3, db, '', f.snapshot.document.projectId)).rejects.toThrow('허용 목록');
  const plan = await prepareEmbeddingPlan(f.space.id, [f.a.id], 3, db, '', f.snapshot.document.projectId);
  expect(plan.projectScope?.versionId).toBeNull(); expect(plan.projectScope?.projectId).toBe(f.snapshot.document.projectId);
  const fetchMock = fake();
  await saveProjectSources(f.snapshot, 1, [f.a.id], db, 'research');
  await expect(indexEmbeddingPlan(plan, 'key', new AbortController().signal, () => {}, db)).rejects.toThrow('변경');
  expect(fetchMock).not.toHaveBeenCalled();
  const current = await captureEmbeddingScope('', [f.a.id], db, f.snapshot.document.projectId);
  await assertEmbeddingScopeCurrent(current, [f.a.id], db);
  await moveTheoryProject(f.snapshot, { newTitle: 'Another' }, db);
  await expect(assertEmbeddingScopeCurrent(current, [f.a.id], db)).rejects.toThrow('변경');
});
