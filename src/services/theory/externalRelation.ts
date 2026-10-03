import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { assertExternalReviewCurrent } from './externalReview';
import { hashText } from './blocks';
import { approveRelation, claimAnchor, validateRelationProposal, type RelationProposal } from './relations';
import { externalAssessmentHash } from './relationValidation';
import { COMPATIBILITY_LABELS, type CompatibilityAssessment } from './relationTypes';

export interface ExternalRelationInput extends CompatibilityAssessment { claimRunId: string; claimId: string; kind: 'supports' | 'contradicts'; note: string }
export async function prepareExternalRelation(runId: string, pairId: string, input: ExternalRelationInput, db: QaxiomDatabase = qaxiomDatabase) {
  const run = await db.review_runs.get(runId);
  if (!run) throw new Error('외부 대조 이력이 없습니다.');
  const state = await assertExternalReviewCurrent(run, db);
  const pair = run.external!.context.pairs.find(p => p.id === pairId), assessment = run.external!.assessments.find(a => a.pairId === pairId);
  if (!pair || !assessment || !run.external!.checkedPairIds.includes(pairId)) throw new Error('실제 대조한 쌍만 관계 승인에 연결할 수 있습니다.');
  if (!['supports', 'contradicts'].includes(input.kind) || !COMPATIBILITY_LABELS.includes(input.label)
    || [input.note, input.theoryConditions, input.referenceConditions].some(s => typeof s !== 'string' || !s.trim() || s.length > 2000)) throw new Error('관계 종류·사용자 분류·양쪽 조건·승인 사유를 입력하세요.');
  const claimRun = await db.review_runs.get(input.claimRunId);
  if (!claimRun || claimRun.documentId !== run.documentId || claimRun.versionId !== run.versionId) throw new Error('현재 버전의 채택된 주장을 선택하세요.');
  const from = claimAnchor(claimRun, input.claimId);
  if (from.blockId !== pair.blockId || !from.quote.includes(assessment.theoryQuote)) throw new Error('선택 주장이 실제 대조 인용을 포함하지 않습니다.');
  const e = run.external!.context.evidence.find(e => e.citationId === pair.citationId)!;
  const proposal: RelationProposal = { documentId: run.documentId, from,
    to: { type: 'reference', sourceId: e.sourceId, sourceHash: e.sourceHash, spanId: e.span.id, spanHash: e.span.contentHash, quote: e.span.text },
    kind: input.kind, dependencyType: null, assessment: { label: input.label, theoryConditions: input.theoryConditions.trim(), referenceConditions: input.referenceConditions.trim() }, note: input.note.trim(),
    externalReviewOrigin: { runId, pairId, contextHash: run.external!.context.contextHash, assessmentHash: await externalAssessmentHash(assessment) } };
  await validateRelationProposal(proposal, db);
  if (JSON.stringify(await db.review_runs.get(runId)) !== JSON.stringify(run)) throw new Error('대조 결과가 변경되었습니다.');
  return { runId, pairId, input: structuredClone(input), proposal, stateHash: await hashText(state.signature), assessment: structuredClone(assessment), sourceName: e.name };
}
export type ExternalRelationPreview = Awaited<ReturnType<typeof prepareExternalRelation>>;
export async function approveExternalRelation(approved: ExternalRelationPreview, db: QaxiomDatabase = qaxiomDatabase) {
  const fresh = await prepareExternalRelation(approved.runId, approved.pairId, approved.input, db);
  if (JSON.stringify(fresh) !== JSON.stringify(approved)) throw new Error('대조/주장/출처 또는 승인 입력이 변경되었습니다. 미리보기를 다시 확인하세요.');
  return approveRelation(fresh.proposal, db);
}
