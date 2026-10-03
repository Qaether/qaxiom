import { expect, it } from 'vitest';
import { rankUndeclaredImpact } from './impactRanking';
import type { DocumentBlock } from './types';
const block = (text: string, position = 0): DocumentBlock => ({ id: `b${position}`, text, position, versionId: 'v', documentId: 'd', startOffset: 0, endOffset: text.length, contentHash: '', kind: 'paragraph', predecessorIds: [] });

it('finds removed, added and retained symbols including formula-only changes', () => {
  const result = rankUndeclaredImpact({ before: 'Alpha κ = 2', replacement: 'Beta κ = 3', blocks: [block('ALPHA'), block('beta', 1), block('κ = 10', 2), block('unrelated', 3)], excludedBlockIds: [] });
  expect(result.matches.map(m => m.blockId)).toEqual(['b0', 'b1', 'b2']);
  expect(result.matches[0].removed).toEqual(['alpha']); expect(result.matches[1].added).toEqual(['beta']); expect(result.matches[2].retained).toEqual(['κ']);
});
it('normalizes Korean bigrams and full-width symbols but never infers synonyms', () => {
  const result = rankUndeclaredImpact({ before: '광자의 Ｘ', replacement: '광자는 Ｘ', blocks: [block('광자를 x'), block('photon', 1)], excludedBlockIds: [] });
  expect(result.matches).toHaveLength(1); expect(result.matches[0].retained).toContain('ko:광자'); expect(result.matches[0].retained).toContain('x');
});
it('excludes existing scope and reports all matching omissions beyond 24 deterministically', () => {
  const blocks = Array.from({ length: 30 }, (_, i) => block('symbol', i));
  const result = rankUndeclaredImpact({ before: 'symbol', replacement: 'symbol changed', blocks, excludedBlockIds: ['b0'] });
  expect(result.scannedBlockCount).toBe(29); expect(result.matches).toHaveLength(24); expect(result.matches[0].blockId).toBe('b1'); expect(result.omittedMatchCount).toBe(5);
});
it('does not silently trim oversized terms or search corpora', () => {
  const input = { before: '', replacement: Array.from({ length: 1001 }, (_, i) => `term${i}`).join(' '), blocks: [block('term1')], excludedBlockIds: [] };
  expect(() => rankUndeclaredImpact(input)).toThrow('생략하지');
  expect(() => rankUndeclaredImpact({ ...input, replacement: 'x', blocks: [block('x'.repeat(2000001))] })).toThrow('범위');
  expect(() => rankUndeclaredImpact({ ...input, replacement: 'x', excludedBlockIds: ['unknown'] })).toThrow('범위');
});
it('returns no match rather than calling unmatched blocks safe', () => {
  expect(rankUndeclaredImpact({ before: 'a', replacement: 'b', blocks: [block('c')], excludedBlockIds: [] }).matches).toEqual([]);
});
