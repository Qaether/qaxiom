import { expect, it } from 'vitest';
import { RETRIEVAL_CASES, evaluationCorpus } from './evaluationFixtures';
import { evaluateRetrieval } from './evaluation';

it('reports the fixed 60-case BM25 baseline including cross-language misses and selected-source boundaries', async () => {
  expect(RETRIEVAL_CASES).toHaveLength(60);
  expect(new Set(RETRIEVAL_CASES.map(test => test.id)).size).toBe(60);
  const report = evaluateRetrieval(await evaluationCorpus(), RETRIEVAL_CASES);
  const { rows: _rows, ...summary } = report;
  console.info('Qaxiom synthetic retrieval baseline', JSON.stringify(summary, null, 2));
  expect(report.overall.leaks).toBe(0);
  expect(report.overall.recall5).toBeCloseTo(51 / 55);
  expect(report.overall.mrr).toBeCloseTo(51 / 55);
  expect(report.overall.noEvidenceAccuracy).toBe(1);
  expect(report.categories.version_selection.recall20).toBe(1);
  expect(report.categories.cross_language.recall20).toBe(0.2);
  expect(report.missed).toEqual(['cross_language-1', 'cross_language-2', 'cross_language-4', 'cross_language-5']);
  expect(report.holdout.cases).toBeGreaterThan(0);
});
