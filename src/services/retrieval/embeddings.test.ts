// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { importReference, loadReferenceSelection } from './references';
import { createEmbeddingSpace, embeddingVectorHash, indexEmbeddingPlan, loadEmbeddingVectors, prepareEmbeddingPlan, requestEmbeddings } from './embeddings';
import { searchHybrid } from './hybrid';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { createContextBundle } from './context';
import { parseContextBundle } from './validation';
import { normalizeVector, type EmbeddingSpace, type EmbeddingVector } from './embeddingTypes';

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`embedding-${crypto.randomUUID()}`); target = new QaxiomDatabase(`embedding-target-${crypto.randomUUID()}`); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await db.delete(); await target.delete(); });
const vector = (axis = 0) => Array.from({ length: 512 }, (_, i) => i === axis ? 1 : 0);
const answer = (count: number) => ({ model: 'text-embedding-3-small', data: Array.from({ length: count }, (_, index) => ({ index, embedding: vector() })), usage: { prompt_tokens: 12 } });
function fakeProvider() {
  const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => new Response(JSON.stringify(answer(JSON.parse(init.body as string).input.length)), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock); return fetchMock;
}
async function fixture() {
  const selected = await importReference('selected.md', 'Light travels through a vacuum.', 'external', db);
  const excluded = await importReference('excluded.md', 'NEVER_SEND_UNSELECTED_SOURCE', 'external', db);
  const space = await createEmbeddingSpace(db); const data = await loadReferenceSelection([selected.source.id], db);
  return { selected, excluded, space, data };
}
async function record(space: EmbeddingSpace, source: Awaited<ReturnType<typeof importReference>>, axis = 0): Promise<EmbeddingVector> {
  const span = (await db.reference_spans.where('sourceId').equals(source.source.id).first())!;
  const value = { spaceId: space.id, sourceId: source.source.id, sourceHash: source.source.contentHash,
    spanId: span.id, spanHash: span.contentHash, values: vector(axis), createdAt: Date.now() };
  return { ...value, vectorHash: await embeddingVectorHash(value) };
}

it('adds schema v7 after populated v6 without changing earlier canonical data', async () => {
  const { selected } = await fixture(); const legacy = new Dexie(target.name);
  const tables = db.tables.filter(t => !['embedding_spaces', 'embedding_vectors', 'embedding_manifests', 'embedding_activations', 'research_relations'].includes(t.name));
  legacy.version(6).stores(Object.fromEntries(tables.map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const table of tables) await legacy.table(table.name).bulkAdd(await table.toArray());
  legacy.close(); await target.open(); expect(target.verno).toBe(25);
  expect(await target.references.get(selected.source.id)).toEqual(selected.source); expect(await target.embedding_spaces.count()).toBe(0);
});

it('sends only explicitly selected text, uses ordered response indices and reuses unchanged cached spans', async () => {
  const { selected, space } = await fixture(); const fetchMock = fakeProvider();
  const plan = await prepareEmbeddingPlan(space.id, [selected.source.id], 3, db);
  expect(fetchMock).not.toHaveBeenCalled();
  await indexEmbeddingPlan(plan, 'mock-key', new AbortController().signal, () => {}, db);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(body).toEqual({ model: space.model, dimensions: 512, encoding_format: 'float', input: [selected.source.text] });
  const next = await prepareEmbeddingPlan(space.id, [selected.source.id], 3, db);
  expect(next.cached).toBe(1); expect(next.batches).toEqual([]);
  const rows = await db.embedding_vectors.toArray(); expect(rows[0].sourceHash).toBe(selected.source.contentHash);
  expect(rows[0].values).toEqual(vector()); expect(rows[0].vectorHash).toBe(await embeddingVectorHash(rows[0]));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...answer(2), data: [{ index: 1, embedding: vector(1) }, { index: 0, embedding: vector(0) }] }))));
  const ordered = await requestEmbeddings(space, ['first', 'second'], 'key', new AbortController().signal);
  expect(ordered.vectors).toEqual([vector(0), vector(1)]);
});

it('splits under request budgets without silently truncating text and lists all unindexed spans', async () => {
  const large = await importReference('large.txt', '가'.repeat(2400 * 30), 'external', db); const space = await createEmbeddingSpace(db);
  const plan = await prepareEmbeddingPlan(space.id, [large.source.id], 1, db);
  expect(plan.batches).toHaveLength(1); expect(plan.omitted.length).toBeGreaterThan(0);
  const joined = [...plan.batches.flat(), ...plan.omitted].map(s => s.text).join(''); expect(joined).toBe(large.source.text);
  expect(new Set([...plan.batches.flat(), ...plan.omitted].map(s => s.id)).size).toBe(30);
  await expect(prepareEmbeddingPlan(space.id, [large.source.id], 0, db)).rejects.toThrow('예산');
});

it('retains the completed batch on cancellation and resumes only uncached spans after a new approval', async () => {
  const large = await importReference('checkpoint.txt', '가'.repeat(2400 * 30), 'external', db), space = await createEmbeddingSpace(db);
  const fetchMock = fakeProvider(), abort = new AbortController();
  const plan = await prepareEmbeddingPlan(space.id, [large.source.id], 3, db);
  await expect(indexEmbeddingPlan(plan, 'key', abort.signal, () => abort.abort(), db)).rejects.toThrow();
  const saved = await db.embedding_vectors.toArray(); expect(saved).toHaveLength(plan.batches[0].length);
  expect((await db.embedding_spaces.get(space.id))!.runId).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(1);
  const next = await prepareEmbeddingPlan(space.id, [large.source.id], 100, db);
  expect(next.cached).toBe(saved.length); expect(next.batches.flat().some(span => saved.some(v => v.spanId === span.id))).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await indexEmbeddingPlan(next, 'key', new AbortController().signal, () => {}, db);
  expect(await db.embedding_vectors.count()).toBe(30);
});

it('rejects incompatible models, response indices, nonfinite/zero vectors and redacts provider failure bodies', async () => {
  const { space } = await fixture(); const signal = new AbortController().signal;
  for (const payload of [{ ...answer(1), model: 'wrong' }, { ...answer(1), data: [{ index: 2, embedding: vector() }] },
    { ...answer(1), data: [{ index: 0, embedding: [1] }] }, { ...answer(1), data: [{ index: 0, embedding: vector().map(() => 0) }] }]) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload))));
    await expect(requestEmbeddings(space, ['text'], 'key', signal)).rejects.toThrow();
  }
  expect(() => normalizeVector([Infinity, 1], 2)).toThrow();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('private user text and mock-key', { status: 401 })));
  await expect(requestEmbeddings(space, ['text'], 'mock-key', signal)).rejects.toThrow('HTTP 401');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('private user text and mock-key')));
  await expect(requestEmbeddings(space, ['text'], 'mock-key', signal)).rejects.toThrow('JSON 형식');
});

it('checks preview scope before transmission and refuses concurrent/late owners while preserving completed checkpoints', async () => {
  const { selected, excluded, space, data } = await fixture(); const fetchMock = fakeProvider();
  const plan = await prepareEmbeddingPlan(space.id, [selected.source.id], 3, db);
  const bad = { ...plan, batches: [[(await db.reference_spans.where('sourceId').equals(excluded.source.id).first())!]] };
  await expect(indexEmbeddingPlan(bad, 'key', new AbortController().signal, () => {}, db)).rejects.toThrow('선택'); expect(fetchMock).not.toHaveBeenCalled();
  await db.embedding_spaces.update(space.id, { runId: 'another-tab', deadlineAt: Date.now() + 120000 });
  await expect(indexEmbeddingPlan(plan, 'key', new AbortController().signal, () => {}, db)).rejects.toThrow('다른 탭');
  await db.embedding_spaces.update(space.id, { runId: null, deadlineAt: null });
  vi.stubGlobal('fetch', vi.fn(async () => {
    await db.embedding_spaces.update(space.id, { runId: 'replacement-owner', deadlineAt: Date.now() + 120000 });
    return new Response(JSON.stringify(answer(1)));
  }));
  await expect(indexEmbeddingPlan(plan, 'key', new AbortController().signal, () => {}, db)).rejects.toThrow('소유권');
  expect(await loadEmbeddingVectors(space, data, db)).toEqual([]);
  expect((await db.embedding_spaces.get(space.id))!.runId).toBe('replacement-owner');
});

it('filters unselected, stale and foreign-generation vectors and combines disjoint BM25/semantic candidates via RRF', async () => {
  const { selected, excluded, space, data } = await fixture();
  const semantic = await record(space, selected), foreign = await record(space, excluded);
  await db.embedding_vectors.bulkAdd([semantic, foreign]);
  expect(await loadEmbeddingVectors(space, data, db)).toEqual([semantic]);
  const hits = searchHybrid(data, '빛', space, [semantic, foreign, { ...semantic, spaceId: 'old-generation' }], vector());
  expect(hits.map(h => h.source.id)).toEqual([selected.source.id]); expect(hits[0].score).toBeCloseTo(1 / 61);
  expect(searchHybrid(data, '빛', space, [{ ...semantic, spanHash: 'stale' }], vector())).toEqual([]);
  expect(searchHybrid(data, 'vacuum', space, [semantic], vector())[0].score).toBeCloseTo(2 / 61);
  const next = await createEmbeddingSpace(db); expect(await loadEmbeddingVectors(next, data, db)).toEqual([]);
});

it('round trips vectors, clears running ownership, rejects hash tampering and imports genuine v6 without caches', async () => {
  const { selected, space } = await fixture(); fakeProvider();
  await indexEmbeddingPlan(await prepareEmbeddingPlan(space.id, [selected.source.id], 3, db), 'key', new AbortController().signal, () => {}, db);
  await db.embedding_spaces.update(space.id, { runId: 'in-flight', deadlineAt: Date.now() + 120000 });
  const bundle = await createWorkspaceBundle(db); expect(bundle.version).toBe(24); await restoreWorkspaceBundle(bundle, target);
  expect(await target.embedding_vectors.toArray()).toEqual(bundle.data.embeddingVectors);
  expect((await target.embedding_spaces.get(space.id))!.runId).toBeNull();
  const bad = structuredClone(bundle); bad.data.embeddingVectors[0].values = vector(1);
  await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow('벡터 해시');
  expect((await target.embedding_vectors.toArray())[0].values).toEqual(vector());
  const { embeddingSpaces: _spaces, embeddingVectors: _vectors, ...legacy } = bundle.data;
  await restoreWorkspaceBundle({ ...bundle, version: 6, data: legacy }, target);
  expect(await target.embedding_vectors.count()).toBe(0); expect(await target.references.count()).toBe(2);
});

it('preserves hybrid generation/coverage on evidence bundles and rejects missing or overlapping coverage', async () => {
  const { selected, space, data } = await fixture(); const row = await record(space, selected); await db.embedding_vectors.add(row);
  const hits = searchHybrid(data, '빛', space, [row], vector());
  const bundle = { ...createContextBundle('빛', [selected.source.id], hits), retriever: 'hybrid-rrf-v1' as const,
    hybrid: { spaceId: space.id, model: space.model, dimensions: space.dimensions, adapterVersion: space.adapterVersion,
      providerRevision: null, coveredSpanIds: [row.spanId], missingSpanIds: [] } };
  const cache = { embeddingSpaces: [space], embeddingVectors: [row], embeddingManifests: [], embeddingActivations: [] };
  expect(parseContextBundle(bundle, data, [], cache).hybrid).toEqual(bundle.hybrid);
  expect(() => parseContextBundle(bundle, data, [])).toThrow();
  expect(() => parseContextBundle({ ...bundle, hybrid: { ...bundle.hybrid, missingSpanIds: [row.spanId] } }, data, [], cache)).toThrow();
});
