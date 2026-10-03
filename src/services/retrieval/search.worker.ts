import { searchBM25 } from './bm25';
import type { ReferenceData } from './types';
import { searchHybrid } from './hybrid';
import type { EmbeddingSpace, EmbeddingVector } from './embeddingTypes';

self.onmessage = (event: MessageEvent<{ data: ReferenceData; query: string; hybrid?: { space: EmbeddingSpace; vectors: EmbeddingVector[]; queryVector: number[] } }>) => {
  try {
    const { data, query, hybrid } = event.data;
    self.postMessage({ hits: hybrid ? searchHybrid(data, query, hybrid.space, hybrid.vectors, hybrid.queryVector) : searchBM25(data, query) });
  }
  catch { self.postMessage({ error: '레퍼런스 검색에 실패했습니다.' }); }
};
