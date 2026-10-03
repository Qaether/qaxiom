export interface EmbeddingSpace {
  id: string;
  provider: 'openai';
  model: 'text-embedding-3-small';
  dimensions: 512;
  adapterVersion: 'openai-embedding-v1';
  providerRevision: null;
  createdAt: number;
  runId: string | null;
  deadlineAt: number | null;
}
export interface EmbeddingVector {
  spaceId: string;
  sourceId: string;
  sourceHash: string;
  spanId: string;
  spanHash: string;
  values: number[];
  vectorHash: string;
  createdAt: number;
}
export interface EmbeddingManifest {
  spaceId: string;
  sources: { id: string; contentHash: string }[];
  spans: { id: string; sourceId: string; contentHash: string; vectorHash: string }[];
  manifestHash: string;
  createdAt: number;
}
export interface EmbeddingActivation {
  id: 'active'; spaceId: string; manifestHash: string; revision: number; activatedAt: number;
}
export interface EmbeddingData {
  embeddingSpaces: EmbeddingSpace[]; embeddingVectors: EmbeddingVector[];
  embeddingManifests: EmbeddingManifest[]; embeddingActivations: EmbeddingActivation[];
}
export interface HybridTrace {
  spaceId: string;
  model: 'text-embedding-3-small';
  dimensions: 512;
  adapterVersion: 'openai-embedding-v1';
  providerRevision: null;
  coveredSpanIds: string[];
  missingSpanIds: string[];
  manifestHash?: string;
  activationRevision?: number;
}

export function validSpace(value: EmbeddingSpace) {
  return value.provider === 'openai' && value.model === 'text-embedding-3-small' && value.dimensions === 512
    && value.adapterVersion === 'openai-embedding-v1' && value.providerRevision === null;
}
export function normalizeVector(values: unknown, dimensions: number): number[] {
  if (!Array.isArray(values) || values.length !== dimensions || values.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('임베딩 차원/숫자 형식이 올바르지 않습니다.');
  const magnitude = Math.hypot(...values);
  if (!Number.isFinite(magnitude) || magnitude <= 0) throw new Error('비어 있거나 유효하지 않은 임베딩 벡터입니다.');
  return values.map(value => value / magnitude);
}
