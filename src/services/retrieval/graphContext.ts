import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { loadTheory } from '../theory/documents';
import { prepareGraphReview } from '../theory/reviewGraph';
import { parseReviewGraph, validateGraphRelations } from '../theory/reviewGraphValidation';
import type { TheoryData, TheorySnapshot } from '../theory/types';
import type { ReviewData } from '../theory/reviewTypes';
import type { RelationData } from '../theory/relationTypes';
import type { ContextBundle } from './types';
import { sameContextValue } from './assembly';
import { loadReferenceSelection } from './references';
import { hashText } from '../theory/blocks';

export type GraphRestoreData = { theory: TheoryData; reviews: ReviewData; relations: RelationData };
export async function prepareGraphContext(snapshot: TheorySnapshot, targets: string[], db: QaxiomDatabase = qaxiomDatabase): Promise<NonNullable<ContextBundle['graph']>> {
  const prepared = await prepareGraphReview(snapshot, targets, db);
  return { context: prepared.graph, blocks: snapshot.blocks.filter(b => prepared.blockIds.includes(b.id)).map(b => structuredClone(b)) };
}
export function parseGraphContext(input: unknown, versionId: string, data: GraphRestoreData): NonNullable<ContextBundle['graph']> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('답변 그래프 문맥이 올바르지 않습니다.');
  const value = input as Record<string, unknown>;
  const context = parseReviewGraph(value.context, versionId, data.theory, data.reviews);
  validateGraphRelations(context, data.relations);
  const ids = [...context.targetBlockIds, ...context.premiseBlockIds];
  const blocks = data.theory.documentBlocks.filter(b => b.versionId === versionId && ids.includes(b.id)).sort((a, b) => a.position - b.position);
  if (!sameContextValue(value.blocks, blocks)) throw new Error('답변 그래프의 정본 블록 원문/범위가 일치하지 않습니다.');
  return { context, blocks: structuredClone(blocks) };
}
export async function assertGraphContextCurrent(bundle: ContextBundle, db: QaxiomDatabase = qaxiomDatabase) {
  if (bundle.retriever === 'graph-canonical-v1' && !bundle.graph) throw new Error('정본 단독 질문에 선택한 그래프가 없습니다.');
  if (!bundle.graph) return;
  const selected = bundle.selectedSourceIds.length ? await loadReferenceSelection(bundle.selectedSourceIds, db) : { references: [], referenceSpans: [] };
  if (bundle.retriever === 'graph-canonical-v1' && (bundle.selectedSourceIds.length || bundle.evidence.length || bundle.hybrid)) throw new Error('정본 단독 문맥에 레퍼런스/의미 검색 결과를 혼합할 수 없습니다.');
  for (const item of bundle.evidence) {
    const source = selected.references.find(s => s.id === item.sourceId), span = selected.referenceSpans.find(s => s.id === item.span.id);
    if (!source || !span || source.contentHash !== item.sourceHash || source.name !== item.name || source.role !== item.role || source.originVersionId !== item.originVersionId
      || !sameContextValue(span, item.span) || await hashText(source.text) !== source.contentHash || await hashText(span.text) !== span.contentHash) throw new Error('선택 원문/출처가 변경되었습니다. 다시 검색하세요.');
  }
  const research = bundle.assembly?.research;
  if (!research) throw new Error('답변 그래프에 필수 연구 기준이 없습니다.');
  const snapshot = await loadTheory(research.documentId, db);
  const current = await prepareGraphContext(snapshot, bundle.graph.context.targetBlockIds, db);
  if (!sameContextValue(bundle.graph, current) || snapshot.version.id !== research.versionId
    || !sameContextValue(snapshot.version.contract, research.contract)) throw new Error('정본/승인 그래프/채택이 변경되었습니다. 검색 미리보기를 다시 확인하세요. 전송 후 변경이라면 제공사 비용은 미확인입니다.');
}
