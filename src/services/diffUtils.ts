export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export interface ComputeDiffResult {
  lines: DiffLine[];
  stats: DiffStats;
}

/**
 * Calculates line-by-line diff using Longest Common Subsequence (LCS).
 * Provides clean additions, deletions, and unchanged lines for inline code/markdown review.
 */
export function computeLineDiff(originalText: string, proposedText: string): ComputeDiffResult {
  const oldLines = originalText ? originalText.split('\n') : [];
  const newLines = proposedText ? proposedText.split('\n') : [];

  if (originalText === proposedText) {
    return {
      lines: oldLines.map((text, i) => ({
        type: 'unchanged',
        text,
        oldLineNumber: i + 1,
        newLineNumber: i + 1,
      })),
      stats: { added: 0, removed: 0 },
    };
  }

  if (oldLines.length === 0) {
    return {
      lines: newLines.map((text, i) => ({
        type: 'added',
        text,
        newLineNumber: i + 1,
      })),
      stats: { added: newLines.length, removed: 0 },
    };
  }

  if (newLines.length === 0) {
    return {
      lines: oldLines.map((text, i) => ({
        type: 'removed',
        text,
        oldLineNumber: i + 1,
      })),
      stats: { added: 0, removed: oldLines.length },
    };
  }

  const n = oldLines.length;
  const m = newLines.length;

  // 2D DP for line-based LCS
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (oldLines[i] === newLines[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const stack: DiffLine[] = [];
  let i = n;
  let j = m;
  let added = 0;
  let removed = 0;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({
        type: 'unchanged',
        text: oldLines[i - 1],
        oldLineNumber: i,
        newLineNumber: j,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({
        type: 'added',
        text: newLines[j - 1],
        newLineNumber: j,
      });
      added++;
      j--;
    } else if (i > 0) {
      stack.push({
        type: 'removed',
        text: oldLines[i - 1],
        oldLineNumber: i,
      });
      removed++;
      i--;
    }
  }

  const lines: DiffLine[] = [];
  while (stack.length > 0) {
    lines.push(stack.pop()!);
  }

  return { lines, stats: { added, removed } };
}
