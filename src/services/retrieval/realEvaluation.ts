import { hashText } from '../theory/blocks';
import { evaluateRetrieval } from './evaluation';
import type { RetrievalCase } from './evaluationFixtures';
import type { ReferenceData } from './types';

export interface LabelledRetrievalManifest {
  format: 'qaxiom-labelled-retrieval';
  version: 1;
  labeler: string;
  sources: { sourceId: string; sourceHash: string }[];
  cases: {
    id: string; category: string; split: 'development' | 'holdout'; query: string;
    selectedSourceIds: string[]; expected: { spanId: string; spanHash: string }[];
    rationale: string;
  }[];
}

const digest = /^[a-f0-9]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
function fail(message: string): never { throw new Error(`실문헌 검색 평가 입력 오류: ${message}`); }
function unique(values: string[], label: string) { if (new Set(values).size !== values.length) fail(`${label} 중복`); }

/** The manifest must be authored independently of retrieval output. Validation cannot prove annotator independence. */
export async function evaluateLabelledRetrieval(data: ReferenceData, input: unknown) {
  if (!isRecord(input) || input.format !== 'qaxiom-labelled-retrieval' || input.version !== 1 || !text(input.labeler)
    || !Array.isArray(input.sources) || !input.sources.length || input.sources.length > 1000
    || !Array.isArray(input.cases) || !input.cases.length || input.cases.length > 1000) fail('형식·버전·라벨 작성자·목록');
  const manifest = input as unknown as LabelledRetrievalManifest;
  unique(data.references.map(source => source.id), '작업공간 자료 ID');
  unique(data.referenceSpans.map(span => span.id), '작업공간 구간 ID');
  const sources = new Map(data.references.map(source => [source.id, source]));
  const spans = new Map(data.referenceSpans.map(span => [span.id, span]));
  const sourceIds: string[] = [];
  for (const pin of manifest.sources) {
    if (!isRecord(pin) || !text(pin.sourceId) || typeof pin.sourceHash !== 'string' || !digest.test(pin.sourceHash)) fail('자료 고정 hash');
    const source = sources.get(pin.sourceId);
    if (!source || source.contentHash !== pin.sourceHash || await hashText(source.text) !== pin.sourceHash) fail(`자료 변경: ${pin.sourceId}`);
    sourceIds.push(pin.sourceId);
  }
  unique(sourceIds, '자료 ID');
  const allowed = new Set(sourceIds);
  const selectedSpans = data.referenceSpans.filter(span => allowed.has(span.sourceId));
  for (const span of selectedSpans) {
    const source = sources.get(span.sourceId);
    if (!source || await hashText(span.text) !== span.contentHash
      || source.text.slice(span.startOffset, span.endOffset) !== span.text) fail(`구간 원문 변경: ${span.id}`);
  }
  const cases: RetrievalCase[] = [];
  for (const row of manifest.cases) {
    if (!isRecord(row) || !text(row.id) || !text(row.category) || !text(row.query) || !text(row.rationale)
      || !['development', 'holdout'].includes(row.split) || !Array.isArray(row.selectedSourceIds)
      || !row.selectedSourceIds.length || !row.selectedSourceIds.every(text) || !Array.isArray(row.expected)) fail('질의·범위·근거 설명');
    unique(row.selectedSourceIds, `질의 ${row.id} 선택 자료`);
    if (row.selectedSourceIds.some(id => !allowed.has(id))) fail(`질의 ${row.id} 범위 밖 자료`);
    const expected: string[] = [];
    for (const pin of row.expected) {
      if (!isRecord(pin) || !text(pin.spanId) || typeof pin.spanHash !== 'string' || !digest.test(pin.spanHash)) fail(`질의 ${row.id} 정답 구간`);
      const span = spans.get(pin.spanId);
      if (!span || !row.selectedSourceIds.includes(span.sourceId) || span.contentHash !== pin.spanHash) fail(`질의 ${row.id} 정답이 선택 범위 밖이거나 변경됨`);
      expected.push(pin.spanId);
    }
    unique(expected, `질의 ${row.id} 정답 구간`);
    cases.push({ id: row.id, category: row.category, split: row.split, query: row.query, expected, selected: [...row.selectedSourceIds] });
  }
  unique(cases.map(row => row.id), '질의 ID');
  if (!cases.some(row => row.split === 'development') || !cases.some(row => row.split === 'holdout')) fail('개발/보류 분할 모두 필요');
  const scoped: ReferenceData = { references: data.references.filter(source => allowed.has(source.id)), referenceSpans: selectedSpans };
  return evaluateRetrieval(scoped, cases);
}
