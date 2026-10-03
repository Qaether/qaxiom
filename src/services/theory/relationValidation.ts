import type { TheoryData } from './types';
import type { ReviewData } from './reviewTypes';
import type { ReferenceData } from '../retrieval/types';
import { COMPATIBILITY_LABELS, RELATION_KINDS, anchorKey, type ClaimAnchor, type ReferenceAnchor, type ResearchRelation, type RelationData } from './relationTypes';
import { hashText } from './blocks';
import type { ExternalAssessment } from './externalReview';
import type { ReviewRun } from './reviewTypes';

export const externalAssessmentHash = (a: ExternalAssessment) => hashText(JSON.stringify({ pairId: a.pairId, label: a.label,
  theoryQuote: a.theoryQuote, referenceQuote: a.referenceQuote, theoryConditions: a.theoryConditions, referenceConditions: a.referenceConditions, explanation: a.explanation,
  ...(a.referenceClaim ? { referenceClaim: a.referenceClaim } : {}) }));

export const relationHash = (relation: Omit<ResearchRelation, 'relationHash'>) => hashText(JSON.stringify({
  id: relation.id, documentId: relation.documentId, from: relation.from, to: relation.to, kind: relation.kind,
  dependencyType: relation.dependencyType, assessment: relation.assessment, note: relation.note, createdAt: relation.createdAt,
  retractedAt: relation.retractedAt, retractionNote: relation.retractionNote,
  ...(relation.externalReviewOrigin ? { externalReviewOrigin: relation.externalReviewOrigin } : {})
}));
export function parseRelationData(value: unknown, theory: TheoryData, reviews: ReviewData, references: ReferenceData): RelationData {
  const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const text = (x: unknown): x is string => typeof x === 'string' && !!x.trim();
  const time = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  function fail(): never { throw new Error('주장 관계의 버전·원문·승인 참조가 올바르지 않습니다.'); }
  function claimAnchor(x: unknown, documentId: string): ClaimAnchor {
    if (!record(x) || x.type !== 'claim' || !['runId', 'claimId', 'versionId', 'versionHash', 'blockId', 'blockHash', 'quote'].every(k => text(x[k]))) fail();
    const run = reviews.reviewRuns.find(r => r.id === x.runId), claim = run?.claims.find(c => c.id === x.claimId);
    const version = theory.documentVersions.find(v => v.id === x.versionId);
    const block = theory.documentBlocks.find(b => b.versionId === x.versionId && b.id === x.blockId);
    if (!run || run.status !== 'complete' || run.documentId !== documentId || run.versionId !== x.versionId || run.versionHash !== x.versionHash
      || !claim || claim.blockId !== x.blockId || claim.blockHash !== x.blockHash || claim.statement !== x.quote
      || !version || version.documentId !== documentId || version.contentHash !== x.versionHash || block?.contentHash !== x.blockHash || !block.text.includes(x.quote as string)) fail();
    return { type: 'claim', runId: x.runId as string, claimId: x.claimId as string, versionId: x.versionId as string,
      versionHash: x.versionHash as string, blockId: x.blockId as string, blockHash: x.blockHash as string, quote: x.quote as string };
  }
  if (!record(value) || !Array.isArray(value.researchRelations) || value.researchRelations.length > 10000) fail();
  const researchRelations: ResearchRelation[] = value.researchRelations.map(x => {
    if (!record(x) || !text(x.id) || !text(x.documentId) || !RELATION_KINDS.includes(x.kind as ResearchRelation['kind'])
      || !text(x.note) || x.note.length > 2000 || !time(x.createdAt) || !text(x.relationHash)
      || !(x.retractedAt === null ? x.retractionNote === '' : time(x.retractedAt) && x.retractedAt >= x.createdAt && text(x.retractionNote) && x.retractionNote.length <= 2000)) fail();
    const from = claimAnchor(x.from, x.documentId);
    let to: ClaimAnchor | ReferenceAnchor;
    if (record(x.to) && x.to.type === 'reference') {
      const target = x.to;
      if (!['sourceId', 'sourceHash', 'spanId', 'spanHash', 'quote'].every(k => text(target[k]))) fail();
      const source = references.references.find(s => s.id === target.sourceId), span = references.referenceSpans.find(s => s.id === target.spanId);
      if (!source || !span || span.sourceId !== source.id || source.contentHash !== target.sourceHash || span.contentHash !== target.spanHash || span.text !== target.quote) fail();
      to = { type: 'reference', sourceId: target.sourceId as string, sourceHash: target.sourceHash as string,
        spanId: target.spanId as string, spanHash: target.spanHash as string, quote: target.quote as string };
    } else to = claimAnchor(x.to, x.documentId);
    if (anchorKey(from) === anchorKey(to) || to.type === 'claim' && from.versionId !== to.versionId) fail();
    if (x.kind === 'depends_on' ? to.type !== 'claim' || !['proof', 'concept'].includes(String(x.dependencyType)) : x.dependencyType !== null) fail();
    let assessment: ResearchRelation['assessment'] = null;
    if (to.type === 'reference') {
      if (!['supports', 'contradicts'].includes(String(x.kind)) || !record(x.assessment)
        || !COMPATIBILITY_LABELS.includes(x.assessment.label as NonNullable<ResearchRelation['assessment']>['label'])
        || !text(x.assessment.theoryConditions) || !text(x.assessment.referenceConditions)
        || x.assessment.theoryConditions.length > 2000 || x.assessment.referenceConditions.length > 2000) fail();
      assessment = { label: x.assessment.label as NonNullable<ResearchRelation['assessment']>['label'],
        theoryConditions: x.assessment.theoryConditions, referenceConditions: x.assessment.referenceConditions };
    } else if (x.assessment !== null) fail();
    let externalReviewOrigin: ResearchRelation['externalReviewOrigin'];
    if (x.externalReviewOrigin !== undefined) {
      const o = x.externalReviewOrigin;
      if (!record(o) || !text(o.runId) || !text(o.pairId) || !text(o.contextHash) || !text(o.assessmentHash)
        || !/^[a-f0-9]{64}$/.test(o.contextHash) || !/^[a-f0-9]{64}$/.test(o.assessmentHash) || to.type !== 'reference') fail();
      const run = reviews.reviewRuns.find(r => r.id === o.runId), c = run?.external?.context;
      const p = c?.pairs.find(p => p.id === o.pairId), a = run?.external?.assessments.find(a => a.pairId === o.pairId);
      const e = c?.evidence.find(e => e.citationId === p?.citationId);
      if (!run || run.status !== 'complete' || run.checker !== 'external-v1' || run.documentId !== x.documentId
        || run.versionId !== from.versionId || run.versionHash !== from.versionHash || c?.contextHash !== o.contextHash
        || !run.external?.checkedPairIds.includes(o.pairId) || !p || p.blockId !== from.blockId || !a || !from.quote.includes(a.theoryQuote)
        || !e || e.sourceId !== to.sourceId || e.sourceHash !== to.sourceHash || e.span.id !== to.spanId || e.span.contentHash !== to.spanHash
        || e.span.text !== to.quote || !to.quote.includes(a.referenceQuote)) fail();
      externalReviewOrigin = { runId: o.runId, pairId: o.pairId, contextHash: o.contextHash, assessmentHash: o.assessmentHash };
    }
    return { id: x.id, documentId: x.documentId, from, to, kind: x.kind as ResearchRelation['kind'], dependencyType: x.dependencyType as ResearchRelation['dependencyType'],
      ...(externalReviewOrigin ? { externalReviewOrigin } : {}),
      assessment, note: x.note, createdAt: x.createdAt, retractedAt: x.retractedAt as number | null, retractionNote: x.retractionNote as string, relationHash: x.relationHash };
  });
  if (new Set(researchRelations.map(r => r.id)).size !== researchRelations.length) fail();
  const counts = new Map<string, number>(), activeEdges = new Set<string>();
  for (const r of researchRelations) {
    const count = (counts.get(r.documentId) ?? 0) + 1; counts.set(r.documentId, count);
    if (count > 1000) fail();
    if (r.retractedAt === null) {
      const key = JSON.stringify([r.documentId, anchorKey(r.from), anchorKey(r.to), r.kind, r.dependencyType]);
      if (activeEdges.has(key)) fail(); activeEdges.add(key);
    }
  }
  return { researchRelations };
}
export async function verifyRelationHashes(data: RelationData, runs: ReviewRun[] = []) {
  for (const relation of data.researchRelations) if (await relationHash(relation) !== relation.relationHash) throw new Error('주장 관계 해시가 일치하지 않습니다. 기존 작업공간을 유지합니다.');
  for (const relation of data.researchRelations) if (relation.externalReviewOrigin) {
    const o = relation.externalReviewOrigin, a = runs.find(r => r.id === o.runId)?.external?.assessments.find(a => a.pairId === o.pairId);
    if (!a || await externalAssessmentHash(a) !== o.assessmentHash) throw new Error('외부 대조 결과 계보 hash가 다릅니다. 기존 작업공간을 유지합니다.');
  }
}
