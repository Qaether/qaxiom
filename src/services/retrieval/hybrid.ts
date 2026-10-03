import { searchBM25 } from './bm25';
import { normalizeVector, validSpace, type EmbeddingSpace, type EmbeddingVector } from './embeddingTypes';
import type { ReferenceData, RetrievalHit } from './types';

export function searchHybrid(data: ReferenceData, query: string, space: EmbeddingSpace, records: EmbeddingVector[], queryVector: number[], limit = 12): RetrievalHit[] {
  if (!validSpace(space)) throw new Error('색인 공간 계약이 다릅니다.');
  const q = normalizeVector(queryVector, space.dimensions);
  const spans = new Map(data.referenceSpans.map(s => [s.id, s])), sources = new Map(data.references.map(s => [s.id, s]));
  const semantic = records.flatMap(record => {
    const span = spans.get(record.spanId), source = sources.get(record.sourceId);
    if (record.spaceId !== space.id || !span || !source || record.spanHash !== span.contentHash || record.sourceHash !== source.contentHash || span.sourceId !== source.id) return [];
    const v = normalizeVector(record.values, space.dimensions);
    const score = v.reduce((sum, value, i) => sum + value * q[i], 0);
    return score > 0 ? [{ span, source, score }] : [];
  }).sort((a, b) => b.score - a.score || a.span.id.localeCompare(b.span.id)).slice(0, 20);
  const combined = new Map<string, RetrievalHit>();
  for (const ranking of [searchBM25(data, query, 20), semantic]) ranking.forEach((hit, index) => {
    const current = combined.get(hit.span.id); combined.set(hit.span.id, { ...hit, score: (current?.score ?? 0) + 1 / (60 + index + 1) });
  });
  return [...combined.values()].sort((a, b) => b.score - a.score || a.span.id.localeCompare(b.span.id)).slice(0, Math.max(0, limit));
}
