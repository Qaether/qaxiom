import { splitMarkdown } from '../theory/blocks';
import { EMPTY_CONTRACT, type DocumentVersion } from '../theory/types';
import { createContextBundle, MAX_EVIDENCE_CHARS } from './context';
import type { ContextBundle, ReferenceData, RetrievalHit } from './types';

// JSON object property order is not part of the persisted data contract.
export function sameContextValue(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)])) : value;
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

/** Structural context only: ATX Markdown sections, or the same PDF page.
 * Does not infer mathematical dependencies, reading order, or semantic truth. */
export function parentCandidates(hit: RetrievalHit, data: ReferenceData): RetrievalHit[] {
  const spans = data.referenceSpans.filter(span => span.sourceId === hit.source.id)
    .sort((a, b) => a.position - b.position);
  if (hit.source.pdf) return spans.filter(span => span.page === hit.span.page)
    .map(span => ({ ...hit, span }));
  const headings = splitMarkdown(hit.source.text).filter(part => part.kind === 'heading')
    .map(part => ({ ...part, depth: /^\s*(#{1,6})\s/.exec(part.text)![1].length }));
  const stack: typeof headings = [];
  for (const heading of headings) {
    if (heading.startOffset > hit.span.startOffset) break;
    while (stack.length && stack.at(-1)!.depth >= heading.depth) stack.pop();
    stack.push(heading);
  }
  const parent = stack.at(-1);
  if (!parent) return [];
  const end = headings.find(heading => heading.startOffset > parent.startOffset && heading.depth <= parent.depth)?.startOffset ?? hit.source.text.length;
  const ancestors = spans.filter(span => stack.some(heading => span.startOffset >= heading.startOffset && span.startOffset < heading.endOffset));
  const siblings = spans.filter(span => span.startOffset >= parent.startOffset && span.startOffset < end);
  return [...new Map([...ancestors, ...siblings].map(span => [span.id, { ...hit, span }])).values()];
}

export function assembleContext(query: string, selectedSourceIds: string[], hits: RetrievalHit[], data: ReferenceData, version: DocumentVersion | null = null, graph?: ContextBundle['graph']) {
  if (graph && (!version || graph.context.versionId !== version.id || graph.context.versionHash !== version.contentHash)) throw new Error('그래프와 필수 연구 기준의 정본 버전이 다릅니다.');
  const research = version ? {
    documentId: version.documentId, versionId: version.id, number: version.number,
    title: version.title, contentHash: version.contentHash, contract: { ...version.contract },
    ...(Object.keys(version.contractAnchors ?? {}).length ? { contractAnchors: structuredClone(version.contractAnchors) } : {}),
    emptyFields: (Object.keys(EMPTY_CONTRACT) as (keyof typeof EMPTY_CONTRACT)[]).filter(key => !version.contract[key].trim())
  } : null;
  const contractChars = (research ? JSON.stringify(research).length : 0) + (graph ? JSON.stringify(graph).length : 0);
  const makeBundle = (items: RetrievalHit[]): ContextBundle => {
    if (items.length) return createContextBundle(query, selectedSourceIds, items);
    if (!graph || !query.trim() || selectedSourceIds.length || !graph.context.targetBlockIds.length || !graph.blocks.length) throw new Error('정본 단독 질문에는 질문과 선택한 정본 목표가 필요하며 외부 자료는 포함하지 않습니다.');
    return { id: crypto.randomUUID(), version: 1, query, createdAt: Date.now(), retriever: 'graph-canonical-v1', selectedSourceIds: [], evidence: [] };
  };
  const bundle = makeBundle(hits);
  let chars = bundle.evidence.reduce((sum, item) => sum + item.span.text.length, 0) + contractChars;
  if (chars > MAX_EVIDENCE_CHARS) throw new Error('필수 연구 기준과 선택 근거가 12,000자 예산을 넘습니다. 연구 기준은 자르지 않습니다. 근거를 줄이거나 검토를 나눠 주세요.');
  const expanded = [...hits], included = new Set(hits.map(hit => hit.span.id));
  const omittedSpanIds: string[] = [], parentSpanIds: string[] = [];
  const candidates = new Map<string, RetrievalHit>();
  for (const hit of hits) {
    const source = data.references.find(source => source.id === hit.source.id);
    const span = data.referenceSpans.find(span => span.id === hit.span.id);
    if (!source || !span || span.sourceId !== source.id || !sameContextValue(source, hit.source)
      || !sameContextValue(span, hit.span)) throw new Error('검색 원문이 바뀌었습니다. 다시 검색해 주세요.');
    for (const candidate of parentCandidates(hit, data)) if (!candidates.has(candidate.span.id)) candidates.set(candidate.span.id, candidate);
  }
  for (const candidate of candidates.values()) {
    if (included.has(candidate.span.id)) continue;
    if (expanded.length >= 8 || chars + candidate.span.text.length > MAX_EVIDENCE_CHARS) {
      omittedSpanIds.push(candidate.span.id); continue;
    }
    expanded.push(candidate); included.add(candidate.span.id); parentSpanIds.push(candidate.span.id);
    chars += candidate.span.text.length;
  }
  const result = makeBundle(expanded);
  const omissions = omittedSpanIds.map(id => {
    const { source, span } = candidates.get(id)!;
    return { spanId: span.id, sourceId: source.id, name: source.name,
      startLine: span.startLine, endLine: span.endLine, startOffset: span.startOffset, endOffset: span.endOffset,
      ...(span.page !== undefined ? { page: span.page } : {}), reason: 'context_budget' as const };
  });
  result.assembly = { matchedSpanIds: hits.map(hit => hit.span.id), parentSpanIds, omittedSpanIds, omissions, research };
  if (graph) result.graph = structuredClone(graph);
  return result;
}
