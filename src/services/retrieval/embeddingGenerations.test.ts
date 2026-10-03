// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { createContextBundle } from './context';
import { parseContextBundle } from './validation';
import { importReference } from './references';
import { createEmbeddingSpace, prepareEmbeddingPlan, indexEmbeddingPlan } from './embeddings';
import { activateGeneration, prepareGenerationActivation, loadActiveGeneration, assertActiveGeneration } from './embeddingGenerations';
import { searchHybrid } from './hybrid';
import { createTheory } from '../theory/documents';
import { EMPTY_CONTRACT } from '../theory/types';

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => {
  db = new QaxiomDatabase(`generations-${crypto.randomUUID()}`); target = new QaxiomDatabase(`generations-target-${crypto.randomUUID()}`);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const input = JSON.parse(init.body as string).input;
    return new Response(JSON.stringify({ model: 'text-embedding-3-small', data: input.map((_s: string, index: number) => ({ index,
      embedding: Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0) })) }));
  }));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await db.delete(); await target.delete(); });
async function fixture() {
  const source = (await importReference('paper.md', 'Photon has no rest mass.', 'external', db)).source;
  const space = await createEmbeddingSpace(db);
  await indexEmbeddingPlan(await prepareEmbeddingPlan(space.id, [source.id], 3, db), 'mock-key', new AbortController().signal, () => {}, db);
  const preview = await prepareGenerationActivation(space.id, [source.id], db);
  const active = await activateGeneration(preview, db);
  return { source, space, preview, active };
}

it('seals a complete manifest, keeps the active pointer during partial builds, then atomically switches and returns to an older generation', async () => {
  const { source, space, active } = await fixture();
  const large = (await importReference('large.txt', '가'.repeat(2400 * 30), 'external', db)).source;
  const next = await createEmbeddingSpace(db);
  await indexEmbeddingPlan(await prepareEmbeddingPlan(next.id, [source.id, large.id], 1, db), 'key', new AbortController().signal, () => {}, db);
  await expect(prepareGenerationActivation(next.id, [source.id, large.id], db)).rejects.toThrow('전체');
  expect(await db.embedding_activations.get('active')).toEqual(active);
  expect((await loadActiveGeneration([source.id], db)).space.id).toBe(space.id);
  await indexEmbeddingPlan(await prepareEmbeddingPlan(next.id, [source.id, large.id], 100, db), 'key', new AbortController().signal, () => {}, db);
  const replacement = await activateGeneration(await prepareGenerationActivation(next.id, [source.id, large.id], db), db);
  expect(replacement.revision).toBe(2); expect((await loadActiveGeneration([source.id], db)).vectors).toHaveLength(1);
  const restored = await activateGeneration(await prepareGenerationActivation(space.id, [source.id], db), db);
  expect(restored.revision).toBe(3); expect(restored.spaceId).toBe(space.id);
  expect(await db.embedding_manifests.count()).toBe(2); expect(await db.embedding_vectors.where('spaceId').equals(next.id).count()).toBe(31);
});

it('never activates a cancelled partial checkpoint or overwrites the previous generation', async () => {
  const { active } = await fixture(), source = (await importReference('partial.txt', '가'.repeat(2400 * 30), 'external', db)).source;
  const next = await createEmbeddingSpace(db), controller = new AbortController();
  await expect(indexEmbeddingPlan(await prepareEmbeddingPlan(next.id, [source.id], 100, db), 'key', controller.signal, () => controller.abort(), db)).rejects.toThrow();
  await expect(prepareGenerationActivation(next.id, [source.id], db)).rejects.toThrow('전체');
  expect(await db.embedding_activations.get('active')).toEqual(active);
});

it('locks sealed vectors, rejects stale activation previews and invalidates frozen queries after another activation', async () => {
  const { source, space } = await fixture();
  const before = await loadActiveGeneration([source.id], db);
  const next = await createEmbeddingSpace(db);
  await indexEmbeddingPlan(await prepareEmbeddingPlan(next.id, [source.id], 3, db), 'key', new AbortController().signal, () => {}, db);
  const preview = await prepareGenerationActivation(next.id, [source.id], db);
  await activateGeneration(await prepareGenerationActivation(space.id, [source.id], db), db);
  await expect(activateGeneration(preview, db)).rejects.toThrow('다른 탭');
  await expect(assertActiveGeneration(before.activation, before.data, db)).rejects.toThrow('활성 세대');
  const fetchMock = vi.mocked(fetch); fetchMock.mockClear();
  await expect(indexEmbeddingPlan(await prepareEmbeddingPlan(space.id, [source.id], 3, db), 'key', new AbortController().signal, () => {}, db)).rejects.toThrow('완성 세대');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('refuses unselected-scope additions and raw-vector/source tampering despite unchanged claimed hashes', async () => {
  const { source, space, active } = await fixture();
  const other = (await importReference('private.txt', 'NOT_IN_THIS_GENERATION', 'external', db)).source;
  await expect(loadActiveGeneration([other.id], db)).rejects.toThrow('범위');
  const row = (await db.embedding_vectors.where('spaceId').equals(space.id).first())!;
  await db.embedding_vectors.update([space.id, row.spanId], { values: row.values.map((_v, i) => i === 1 ? 1 : 0) });
  await expect(prepareGenerationActivation(space.id, [source.id], db)).rejects.toThrow('해시');
  expect(await db.embedding_activations.get('active')).toEqual(active);
  await db.embedding_vectors.put(row); await db.references.update(source.id, { text: 'changed without hash' });
  await expect(loadActiveGeneration([source.id], db)).rejects.toThrow('원문 참조');
});

it('revalidates preview completeness and rejects a disappearing vector before publication', async () => {
  const { source, space, active } = await fixture();
  const next = await createEmbeddingSpace(db);
  await indexEmbeddingPlan(await prepareEmbeddingPlan(next.id, [source.id], 3, db), 'key', new AbortController().signal, () => {}, db);
  const preview = await prepareGenerationActivation(next.id, [source.id], db);
  const row = (await db.embedding_vectors.where('spaceId').equals(next.id).first())!;
  await db.embedding_vectors.delete([next.id, row.spanId]);
  await expect(activateGeneration(preview, db)).rejects.toThrow('전체');
  expect((await db.embedding_activations.get('active'))?.spaceId).toBe(space.id);
  expect(await db.embedding_activations.get('active')).toEqual(active);
});

it('round trips v8 complete/active generations and preserves the existing workspace on malformed manifests/pointers', async () => {
  const { active } = await fixture(); const bundle = await createWorkspaceBundle(db);
  expect(bundle.version).toBe(22); await restoreWorkspaceBundle(bundle, target);
  expect(await target.embedding_activations.get('active')).toEqual(active);
  const corrupt = structuredClone(bundle); corrupt.data.embeddingManifests[0].manifestHash = 'bad'; corrupt.data.embeddingActivations[0].manifestHash = 'bad';
  await expect(restoreWorkspaceBundle(corrupt, target)).rejects.toThrow('manifest 해시');
  const missing = structuredClone(bundle); missing.data.embeddingVectors = [];
  await expect(restoreWorkspaceBundle(missing, target)).rejects.toThrow('임베딩 색인');
  const pointer = structuredClone(bundle); pointer.data.embeddingActivations[0].spaceId = 'foreign';
  await expect(restoreWorkspaceBundle(pointer, target)).rejects.toThrow('임베딩 색인');
  expect(await target.embedding_activations.get('active')).toEqual(active);
  const altered = structuredClone(bundle.data.embeddingManifests[0]); altered.spans[0].vectorHash = 'altered';
  await db.embedding_manifests.put(altered);
  await expect(prepareGenerationActivation(active.spaceId, altered.sources.map(s => s.id), db)).rejects.toThrow('manifest 해시');
});

it('imports and migrates genuine v7 caches without silently activating them', async () => {
  const { source, space } = await fixture(); const bundle = await createWorkspaceBundle(db);
  const { embeddingManifests: _m, embeddingActivations: _a, ...data } = bundle.data;
  await restoreWorkspaceBundle({ ...bundle, version: 7, data }, target);
  expect(await target.embedding_vectors.count()).toBe(1); expect(await target.embedding_activations.count()).toBe(0);
  await expect(loadActiveGeneration([source.id], target)).rejects.toThrow('활성화');
  await activateGeneration(await prepareGenerationActivation(space.id, [source.id], target), target);
  expect((await loadActiveGeneration([source.id], target)).vectors).toHaveLength(1);
  await target.delete(); const legacy = new Dexie(target.name);
  const tables = db.tables.filter(t => !['embedding_manifests', 'embedding_activations', 'research_relations'].includes(t.name));
  legacy.version(7).stores(Object.fromEntries(tables.map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const table of tables) await legacy.table(table.name).bulkAdd(await table.toArray());
  legacy.close(); await target.open(); expect(target.verno).toBe(23);
  expect(await target.embedding_vectors.count()).toBe(1); expect(await target.embedding_manifests.count()).toBe(0);
});

it('freezes manifest identity in evidence while retaining historical v7 traces and rejecting forged manifests', async () => {
  const { source } = await fixture(); const current = await loadActiveGeneration([source.id], db);
  const hits = searchHybrid(current.data, '질량', current.space, current.vectors, current.vectors[0].values);
  const bundle = { ...createContextBundle('질량', [source.id], hits), retriever: 'hybrid-rrf-v1' as const,
    hybrid: { spaceId: current.space.id, model: current.space.model, dimensions: current.space.dimensions, adapterVersion: current.space.adapterVersion,
      providerRevision: null, coveredSpanIds: current.vectors.map(v => v.spanId), missingSpanIds: [], manifestHash: current.activation.manifestHash, activationRevision: current.activation.revision } };
  const cache = (await createWorkspaceBundle(db)).data;
  expect(parseContextBundle(bundle, current.data, [], cache).hybrid).toEqual(bundle.hybrid);
  const { manifestHash: _h, activationRevision: _r, ...oldTrace } = bundle.hybrid;
  expect(parseContextBundle({ ...bundle, hybrid: oldTrace }, current.data, [], cache).hybrid).toEqual(oldTrace);
  expect(() => parseContextBundle({ ...bundle, hybrid: { ...bundle.hybrid, manifestHash: 'fake' } }, current.data, [], cache)).toThrow();
});

it('does not mistake deleted or relocated original spans for a fully indexed source', async () => {
  const source = (await importReference('complete.txt', 'A'.repeat(5000), 'external', db)).source;
  const space = await createEmbeddingSpace(db);
  await indexEmbeddingPlan(await prepareEmbeddingPlan(space.id, [source.id], 3, db), 'key', new AbortController().signal, () => {}, db);
  const spans = await db.reference_spans.where('sourceId').equals(source.id).toArray();
  await db.reference_spans.delete(spans[0].id);
  await expect(prepareGenerationActivation(space.id, [source.id], db)).rejects.toThrow('원문 참조');
  await db.reference_spans.put(spans[0]); await db.reference_spans.update(spans[0].id, { startOffset: 1 });
  await expect(prepareGenerationActivation(space.id, [source.id], db)).rejects.toThrow('원문 참조');
  expect(await db.embedding_activations.count()).toBe(0);
});

it('invalidates a query preview when its formerly external source becomes an own-theory snapshot', async () => {
  const { source } = await fixture(); const frozen = await loadActiveGeneration([source.id], db);
  await createTheory({ title: 'Own theory', markdown: source.text, contract: { ...EMPTY_CONTRACT } }, db);
  await expect(assertActiveGeneration(frozen.activation, frozen.data, db)).rejects.toThrow('출처가 변경');
  const fresh = await loadActiveGeneration([source.id], db);
  expect(fresh.data.references[0].role).toBe('theory_snapshot');
});

it('allows only one competing activation publication and refuses activation while a build lease is active', async () => {
  const { source, space, active } = await fixture(); const next = await createEmbeddingSpace(db);
  await indexEmbeddingPlan(await prepareEmbeddingPlan(next.id, [source.id], 3, db), 'key', new AbortController().signal, () => {}, db);
  await db.embedding_spaces.update(next.id, { runId: 'another-tab', deadlineAt: Date.now() + 120000 });
  await expect(prepareGenerationActivation(next.id, [source.id], db)).rejects.toThrow('실행 중');
  expect(await db.embedding_activations.get('active')).toEqual(active);
  await db.embedding_spaces.update(next.id, { runId: null, deadlineAt: null });
  const previews = await Promise.all([prepareGenerationActivation(space.id, [source.id], db), prepareGenerationActivation(next.id, [source.id], db)]);
  const results = await Promise.allSettled(previews.map(p => activateGeneration(p, db)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((await db.embedding_activations.get('active'))!.revision).toBe(2);
});
