import type { ReferenceData } from './types';
import { normalizeVector, validSpace, type EmbeddingData, type EmbeddingSpace, type EmbeddingVector, type EmbeddingManifest, type EmbeddingActivation } from './embeddingTypes';
import { embeddingVectorHash } from './embeddings';
import { embeddingManifestHash } from './embeddingGenerations';

export function parseEmbeddingData(value: unknown, data: ReferenceData, generationVersion = false): EmbeddingData {
  function fail(): never { throw new Error('임베딩 색인의 모델·차원·세대·원문 참조가 올바르지 않습니다.'); }
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
  const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const unique = (ids: string[]) => { if (new Set(ids).size !== ids.length) fail(); };
  if (!record(value) || !Array.isArray(value.embeddingSpaces) || !Array.isArray(value.embeddingVectors)) fail();
  const embeddingSpaces: EmbeddingSpace[] = value.embeddingSpaces.map(s => {
    if (!record(s) || !text(s.id) || !time(s.createdAt) || !validSpace(s as unknown as EmbeddingSpace)
      || (s.runId === null ? s.deadlineAt !== null : !text(s.runId) || !time(s.deadlineAt))) fail();
    return { id: s.id, provider: 'openai', model: 'text-embedding-3-small', dimensions: 512, adapterVersion: 'openai-embedding-v1',
      providerRevision: null, createdAt: s.createdAt, runId: s.runId, deadlineAt: s.deadlineAt } as EmbeddingSpace;
  });
  unique(embeddingSpaces.map(s => s.id));
  const sources = new Map(data.references.map(s => [s.id, s])), spans = new Map(data.referenceSpans.map(s => [s.id, s]));
  const spaces = new Map(embeddingSpaces.map(s => [s.id, s]));
  const embeddingVectors: EmbeddingVector[] = value.embeddingVectors.map(v => {
    if (!record(v) || !text(v.spaceId) || !text(v.sourceId) || !text(v.spanId) || !text(v.vectorHash) || !time(v.createdAt)) fail();
    const space = spaces.get(v.spaceId), source = sources.get(v.sourceId), span = spans.get(v.spanId);
    if (!space || !source || !span || span.sourceId !== source.id || v.sourceHash !== source.contentHash || v.spanHash !== span.contentHash) fail();
    normalizeVector(v.values, space.dimensions);
    if (Math.abs(Math.hypot(...v.values as number[]) - 1) > 1e-6) fail();
    return { spaceId: v.spaceId, sourceId: v.sourceId, sourceHash: source.contentHash, spanId: v.spanId,
      spanHash: span.contentHash, values: [...v.values as number[]], vectorHash: v.vectorHash, createdAt: v.createdAt };
  });
  unique(embeddingVectors.map(v => `${v.spaceId}:${v.spanId}`));
  if (generationVersion && (!Array.isArray(value.embeddingManifests) || !Array.isArray(value.embeddingActivations))) fail();
  const embeddingManifests: EmbeddingManifest[] = generationVersion ? (value.embeddingManifests as unknown[]).map(m => {
    if (!record(m) || !text(m.spaceId) || !text(m.manifestHash) || !time(m.createdAt) || !spaces.has(m.spaceId)
      || !Array.isArray(m.sources) || !m.sources.length || !Array.isArray(m.spans) || !m.spans.length) fail();
    const manifestSources = m.sources.map(s => {
      if (!record(s) || !text(s.id) || sources.get(s.id)?.contentHash !== s.contentHash) fail();
      return { id: s.id, contentHash: s.contentHash as string };
    });
    unique(manifestSources.map(s => s.id));
    const manifestSpans = m.spans.map(s => {
      if (!record(s) || !text(s.id) || !text(s.sourceId) || !text(s.vectorHash) || !manifestSources.some(x => x.id === s.sourceId)
        || spans.get(s.id)?.sourceId !== s.sourceId || spans.get(s.id)?.contentHash !== s.contentHash
        || !embeddingVectors.some(v => v.spaceId === m.spaceId && v.spanId === s.id && v.vectorHash === s.vectorHash)) fail();
      return { id: s.id, sourceId: s.sourceId, contentHash: s.contentHash as string, vectorHash: s.vectorHash };
    });
    unique(manifestSpans.map(s => s.id));
    if (data.referenceSpans.filter(s => manifestSources.some(x => x.id === s.sourceId)).length !== manifestSpans.length) fail();
    return { spaceId: m.spaceId, sources: manifestSources, spans: manifestSpans, manifestHash: m.manifestHash, createdAt: m.createdAt };
  }) : [];
  unique(embeddingManifests.map(m => m.spaceId));
  const embeddingActivations: EmbeddingActivation[] = generationVersion ? (value.embeddingActivations as unknown[]).map(a => {
    if (!record(a) || a.id !== 'active' || !text(a.spaceId) || !time(a.activatedAt) || !time(a.revision) || a.revision < 1
      || !embeddingManifests.some(m => m.spaceId === a.spaceId && m.manifestHash === a.manifestHash)) fail();
    return { id: 'active', spaceId: a.spaceId, manifestHash: a.manifestHash as string, revision: a.revision, activatedAt: a.activatedAt };
  }) : [];
  unique(embeddingActivations.map(a => a.id));
  return { embeddingSpaces, embeddingVectors, embeddingManifests, embeddingActivations };
}

export async function verifyEmbeddingHashes(data: EmbeddingData) {
  for (const vector of data.embeddingVectors) if (await embeddingVectorHash(vector) !== vector.vectorHash) throw new Error('임베딩 벡터 해시가 일치하지 않습니다. 기존 작업공간을 유지합니다.');
  for (const manifest of data.embeddingManifests) if (await embeddingManifestHash(manifest) !== manifest.manifestHash) throw new Error('완성 색인 manifest 해시가 일치하지 않습니다. 기존 작업공간을 유지합니다.');
}
