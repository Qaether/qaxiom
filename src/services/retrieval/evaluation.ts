import { searchBM25 } from './bm25';
import type { ReferenceData } from './types';
import type { RetrievalCase } from './evaluationFixtures';

export function evaluateRetrieval(data: ReferenceData, cases: RetrievalCase[]) {
  const rows = cases.map(test => {
    const selected = test.selected ?? data.references.filter(source => source.id !== 'secret').map(source => source.id);
    const scoped: ReferenceData = {
      references: data.references.filter(source => selected.includes(source.id)),
      referenceSpans: data.referenceSpans.filter(span => selected.includes(span.sourceId))
    };
    if (test.expected.some(id => !scoped.referenceSpans.some(span => span.id === id))) throw new Error(`Invalid label/scope: ${test.id}`);
    const start = performance.now();
    const hits = searchBM25(scoped, test.query, 20);
    const elapsedMs = performance.now() - start;
    const ids = hits.map(hit => hit.span.id);
    const recall = (k: number) => test.expected.length ? test.expected.filter(id => ids.slice(0, k).includes(id)).length / test.expected.length : null;
    const rank = ids.findIndex(id => test.expected.includes(id));
    return { id: test.id, category: test.category, split: test.split, expected: test.expected,
      retrieved: ids, recall5: recall(5), recall20: recall(20), reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1),
      noEvidenceCorrect: test.expected.length ? null : hits.length === 0, elapsedMs,
      leaked: hits.some(hit => !selected.includes(hit.source.id)) };
  });
  const summarize = (subset: typeof rows) => {
    const relevant = subset.filter(row => row.recall20 !== null), empty = subset.filter(row => row.noEvidenceCorrect !== null);
    const latencies = subset.map(row => row.elapsedMs).sort((a, b) => a - b);
    const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    return { cases: subset.length, relevantCases: relevant.length, recall5: average(relevant.map(row => row.recall5!)),
      recall20: average(relevant.map(row => row.recall20!)), mrr: average(relevant.map(row => row.reciprocalRank)),
      noEvidenceAccuracy: average(empty.map(row => row.noEvidenceCorrect ? 1 : 0)),
      leaks: subset.filter(row => row.leaked).length,
      p95Ms: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? 0 };
  };
  return { overall: summarize(rows), development: summarize(rows.filter(row => row.split === 'development')),
    holdout: summarize(rows.filter(row => row.split === 'holdout')),
    categories: Object.fromEntries([...new Set(cases.map(test => test.category))].map(category => [category, summarize(rows.filter(row => row.category === category))])),
    missed: rows.filter(row => row.recall20 !== null && row.recall20 < 1).map(row => row.id), rows };
}
