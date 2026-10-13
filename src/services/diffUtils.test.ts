import { describe, expect, it } from 'vitest';
import { computeLineDiff } from './diffUtils';

describe('computeLineDiff', () => {
  it('returns unchanged lines when original and proposed are identical', () => {
    const text = 'Line 1\nLine 2\nLine 3';
    const result = computeLineDiff(text, text);
    expect(result.stats).toEqual({ added: 0, removed: 0 });
    expect(result.lines).toHaveLength(3);
    expect(result.lines.every(l => l.type === 'unchanged')).toBe(true);
  });

  it('detects added lines when original is empty', () => {
    const proposed = 'New line 1\nNew line 2';
    const result = computeLineDiff('', proposed);
    expect(result.stats).toEqual({ added: 2, removed: 0 });
    expect(result.lines.every(l => l.type === 'added')).toBe(true);
  });

  it('detects removed lines when proposed is empty', () => {
    const original = 'Old line 1\nOld line 2';
    const result = computeLineDiff(original, '');
    expect(result.stats).toEqual({ added: 0, removed: 2 });
    expect(result.lines.every(l => l.type === 'removed')).toBe(true);
  });

  it('detects modifications as combination of removed and added lines', () => {
    const original = 'Header\nOld content\nFooter';
    const proposed = 'Header\nNew content\nFooter';
    const result = computeLineDiff(original, proposed);

    expect(result.stats).toEqual({ added: 1, removed: 1 });
    expect(result.lines).toEqual([
      { type: 'unchanged', text: 'Header', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'removed', text: 'Old content', oldLineNumber: 2 },
      { type: 'added', text: 'New content', newLineNumber: 2 },
      { type: 'unchanged', text: 'Footer', oldLineNumber: 3, newLineNumber: 3 },
    ]);
  });
});
