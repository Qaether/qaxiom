import type { DocumentBlock } from '../theory/types';
import { scoreBM25Texts } from './bm25';

export interface CanonicalHit { blockId: string; score: number }
export function searchCanonicalBlocks(blocks: DocumentBlock[], query: string, limit = 12): CanonicalHit[] {
  if (!query.trim() || query.length > 2000) throw new Error('정본 검색 질문은 1–2,000자 이내로 입력하세요.');
  if (blocks.length > 50000 || blocks.reduce((sum, b) => sum + b.text.length, 0) > 2000000
    || new Set(blocks.map(b => b.id)).size !== blocks.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 12) throw new Error('정본 검색 범위/한도가 올바르지 않습니다.');
  const scores = scoreBM25Texts(blocks.map(block => block.text), query);
  return blocks.map((block, index) => ({ blockId: block.id, score: scores[index], position: block.position }))
    .filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.position - b.position || a.blockId.localeCompare(b.blockId))
    .slice(0, limit).map(({ blockId, score }) => ({ blockId, score }));
}
