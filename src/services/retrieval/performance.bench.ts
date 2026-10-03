import { bench, describe } from 'vitest';
import { searchBM25 } from './bm25';
import type { ReferenceData, ReferenceDocument, ReferenceSpan } from './types';

function corpus(size: number): ReferenceData {
  const references: ReferenceDocument[] = [];
  const referenceSpans: ReferenceSpan[] = [];
  for (let sourceIndex = 0; sourceIndex < Math.ceil(size / 100); sourceIndex++) {
    const id = `source-${sourceIndex}`;
    references.push({ id, name: `${id}.md`, text: '', contentHash: 'benchmark', role: 'external', originVersionId: null,
      parserVersion: 'text-v1', createdAt: 0 });
  }
  for (let index = 0; index < size; index++) {
    const sourceId = `source-${Math.floor(index / 100)}`;
    const text = index % 97 === 0 ? `Quantum spin coupling needle ${index} under positive boundary conditions.`
      : `Reference paragraph ${index} on thermal transport and measured domain conditions.`;
    referenceSpans.push({ id: `span-${index}`, sourceId, position: index % 100, startOffset: 0, endOffset: text.length,
      startLine: 1, endLine: 1, text, contentHash: 'benchmark' });
  }
  return { references, referenceSpans };
}

const tenThousand = corpus(10_000);
const fiftyThousand = corpus(50_000);

describe('warm local BM25 tokenization and scoring, excluding browser/Worker transfer and IndexedDB', () => {
  bench('10,000 spans', () => { searchBM25(tenThousand, 'quantum spin needle', 20); }, { time: 1500, warmupTime: 200 });
  bench('50,000 spans', () => { searchBM25(fiftyThousand, 'quantum spin needle', 20); }, { time: 1500, warmupTime: 200 });
});
