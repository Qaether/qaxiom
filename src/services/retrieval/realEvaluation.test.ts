import { expect, it } from 'vitest';
import { hashText } from '../theory/blocks';
import { splitReference } from './references';
import { evaluateLabelledRetrieval, type LabelledRetrievalManifest } from './realEvaluation';
import type { ReferenceData } from './types';

async function fixture() {
  const text = '# Paper A\n\nQuantum spin coupling appears under condition A.\n\nA separate thermal result.';
  const source = { id: 'a', name: 'paper-a.md', text, contentHash: await hashText(text), role: 'external' as const,
    originVersionId: null, parserVersion: 'text-v1' as const, createdAt: 0 };
  const referenceSpans = await Promise.all(splitReference(text).map(async (part, index) => ({ ...part, id: `a:${index}`,
    sourceId: 'a', position: index, contentHash: await hashText(part.text) })));
  const data: ReferenceData = { references: [source], referenceSpans };
  const answer = referenceSpans.find(span => span.text.includes('Quantum'))!;
  const manifest: LabelledRetrievalManifest = { format: 'qaxiom-labelled-retrieval', version: 1, labeler: 'human-reviewer',
    sources: [{ sourceId: source.id, sourceHash: source.contentHash }], cases: [
      { id: 'q1', category: 'fact', split: 'development', query: 'Quantum spin coupling', selectedSourceIds: ['a'],
        expected: [{ spanId: answer.id, spanHash: answer.contentHash }], rationale: 'Paper A의 조건부 주장 원문' },
      { id: 'q2', category: 'none', split: 'holdout', query: 'unicornontology', selectedSourceIds: ['a'],
        expected: [], rationale: '이 자료에 해당 주장이 없음' }
    ] };
  return { data, manifest, answer };
}

it('evaluates only explicitly pinned sources and independently labelled spans', async () => {
  const { data, manifest } = await fixture();
  const report = await evaluateLabelledRetrieval(data, manifest);
  expect(report.overall.cases).toBe(2);
  expect(report.overall.recall20).toBe(1);
  expect(report.overall.noEvidenceAccuracy).toBe(1);
  expect(report.overall.leaks).toBe(0);
});

it('rejects stale source/span hashes, scope leaks, duplicate labels and missing holdout', async () => {
  const { data, manifest, answer } = await fixture();
  const mutations = [
    (m: LabelledRetrievalManifest) => { m.sources[0].sourceHash = '0'.repeat(64); },
    (m: LabelledRetrievalManifest) => { m.cases[0].expected[0].spanHash = '0'.repeat(64); },
    (m: LabelledRetrievalManifest) => { m.cases[0].selectedSourceIds = ['other']; },
    (m: LabelledRetrievalManifest) => { m.cases[0].expected.push({ spanId: answer.id, spanHash: answer.contentHash }); },
    (m: LabelledRetrievalManifest) => { m.cases[1].split = 'development'; },
    (m: LabelledRetrievalManifest) => { m.cases[0].rationale = ''; }
  ];
  for (const mutate of mutations) { const bad = structuredClone(manifest); mutate(bad); await expect(evaluateLabelledRetrieval(data, bad)).rejects.toThrow(); }
  const forged = structuredClone(data); forged.referenceSpans[1].text = 'forged';
  await expect(evaluateLabelledRetrieval(forged, manifest)).rejects.toThrow('구간 원문 변경');
});
