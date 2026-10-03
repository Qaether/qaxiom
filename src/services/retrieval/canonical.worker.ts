import { searchCanonicalBlocks } from './canonicalRanking';
import type { DocumentBlock } from '../theory/types';

self.onmessage = (event: MessageEvent<{ blocks: DocumentBlock[]; query: string }>) => {
  try { self.postMessage({ hits: searchCanonicalBlocks(event.data.blocks, event.data.query) }); }
  catch (cause) { self.postMessage({ error: cause instanceof Error ? cause.message : '정본 후보 검색 실패' }); }
};
