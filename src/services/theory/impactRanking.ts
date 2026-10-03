import { tokenize } from '../retrieval/bm25';
import type { DocumentBlock } from './types';

export interface ImpactRankingInput { before: string; replacement: string; blocks: DocumentBlock[]; excludedBlockIds: string[] }
export interface ImpactMatch { blockId: string; removed: string[]; added: string[]; retained: string[] }
export interface ImpactRanking { terms: { removed: string[]; added: string[]; retained: string[] }; matches: ImpactMatch[]; omittedMatchCount: number; scannedBlockCount: number }

/** Lexical nomination only. Retained symbols matter when an equation changes without renaming them. */
export function rankUndeclaredImpact(input: ImpactRankingInput): ImpactRanking {
  const blockIds = new Set(input.blocks.map(b => b.id));
  if (input.blocks.length > 50000 || input.blocks.reduce((n, b) => n + b.text.length, 0) > 2000000
    || input.before.length + input.replacement.length > 2000000
    || blockIds.size !== input.blocks.length
    || new Set(input.excludedBlockIds).size !== input.excludedBlockIds.length
    || input.excludedBlockIds.some(id => !blockIds.has(id))) throw new Error('수정 후보 검색 범위/한도가 올바르지 않습니다.');
  const before = new Set(tokenize(input.before)), after = new Set(tokenize(input.replacement));
  if (new Set([...before, ...after]).size > 1000) throw new Error('수정 용어가 1,000개를 초과합니다. 생략하지 않았습니다. 전체 문서 재검사 또는 수동 범위를 선택하세요.');
  const terms = { removed: [...before].filter(t => !after.has(t)).sort(), added: [...after].filter(t => !before.has(t)).sort(), retained: [...before].filter(t => after.has(t)).sort() };
  const excluded = new Set(input.excludedBlockIds);
  const blocks = input.blocks.filter(b => !excluded.has(b.id));
  const matches = blocks.flatMap(block => {
    const words = new Set(tokenize(block.text));
    const match = { blockId: block.id, removed: terms.removed.filter(t => words.has(t)), added: terms.added.filter(t => words.has(t)), retained: terms.retained.filter(t => words.has(t)) };
    return match.removed.length + match.added.length + match.retained.length ? [{ ...match, position: block.position }] : [];
  });
  const weight = (m: ImpactMatch) => 2 * (m.removed.length + m.added.length) + m.retained.length;
  matches.sort((a, b) => weight(b) - weight(a) || a.position - b.position || a.blockId.localeCompare(b.blockId));
  return { terms, matches: matches.slice(0, 24).map(({ blockId, removed, added, retained }) => ({ blockId, removed, added, retained })), omittedMatchCount: Math.max(0, matches.length - 24), scannedBlockCount: blocks.length };
}
