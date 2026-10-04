import type { ReferenceData } from '../retrieval/types';
import { hashText } from './blocks';
import type { ExternalAssessment } from './externalReview';
import { externalAssessmentHash } from './relationValidation';
import type { ReviewData } from './reviewTypes';
import type { TheoryData } from './types';

// Legacy records remain readable and verifiable; this module no longer creates or changes claims.
export interface ExternalClaim {
  id: string;
  projectId: string;
  documentId: string;
  runId: string;
  pairId: string;
  assessmentHash: string;
  sourceId: string;
  sourceHash: string;
  spanId: string;
  spanHash: string;
  claim: NonNullable<ExternalAssessment['referenceClaim']>;
  acceptedAt: number;
  retractedAt: number | null;
  retractionNote: string;
  recordHash: string;
}
export interface ExternalClaimData { externalClaims: ExternalClaim[] }
type UnsignedClaim = Omit<ExternalClaim, 'recordHash'>;
export const externalClaimHash = (claim: UnsignedClaim) => hashText(JSON.stringify({
  id: claim.id, projectId: claim.projectId, documentId: claim.documentId, runId: claim.runId, pairId: claim.pairId,
  assessmentHash: claim.assessmentHash, sourceId: claim.sourceId, sourceHash: claim.sourceHash,
  spanId: claim.spanId, spanHash: claim.spanHash, claim: claim.claim, acceptedAt: claim.acceptedAt,
  retractedAt: claim.retractedAt, retractionNote: claim.retractionNote
}));
export const acceptedExternalClaimHash = (claim: ExternalClaim) => externalClaimHash({ ...claim, retractedAt: null, retractionNote: '' });
function fail(): never { throw new Error('외부 주장 채택의 대조·프로젝트·원문 참조가 올바르지 않습니다. 기존 작업공간을 유지합니다.'); }
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function parseExternalClaimData(input: unknown, theory: TheoryData, review: ReviewData, references: ReferenceData): ExternalClaimData {
  if (!input || typeof input !== 'object' || !Array.isArray((input as ExternalClaimData).externalClaims)
    || (input as ExternalClaimData).externalClaims.length > 10000) fail();
  const rows = (input as ExternalClaimData).externalClaims.map(row => {
    if (!row || typeof row !== 'object' || ![row.id, row.projectId, row.documentId, row.runId, row.pairId,
      row.sourceId, row.sourceHash, row.spanId, row.spanHash, row.assessmentHash, row.recordHash].every(text)
      || !/^[a-f0-9]{64}$/.test(row.recordHash) || !/^[a-f0-9]{64}$/.test(row.assessmentHash)
      || !time(row.acceptedAt) || !(row.retractedAt === null ? row.retractionNote === '' : time(row.retractedAt) && row.retractedAt >= row.acceptedAt && text(row.retractionNote) && row.retractionNote.length <= 2000)) fail();
    const run = review.reviewRuns.find(r => r.id === row.runId), context = run?.external?.context;
    const pair = context?.pairs.find(p => p.id === row.pairId), assessment = run?.external?.assessments.find(a => a.pairId === row.pairId);
    const evidence = context?.evidence.find(e => e.citationId === pair?.citationId);
    const document = theory.theoryDocuments.find(d => d.id === row.documentId);
    const source = references.references.find(s => s.id === row.sourceId), span = references.referenceSpans.find(s => s.id === row.spanId);
    if (!run || run.status !== 'complete' || run.checker !== 'external-v1' || run.documentId !== row.documentId
      || !run.external?.checkedPairIds.includes(row.pairId) || !assessment?.referenceClaim || !pair || !evidence
      || context?.projectScope?.projectId !== row.projectId || !document || !source || !span
      || evidence.sourceId !== row.sourceId || evidence.sourceHash !== row.sourceHash || evidence.span.id !== row.spanId
      || evidence.span.contentHash !== row.spanHash || span.sourceId !== source.id || source.contentHash !== row.sourceHash
      || span.contentHash !== row.spanHash || JSON.stringify(assessment.referenceClaim) !== JSON.stringify(row.claim)) fail();
    return { ...row, claim: { ...row.claim } };
  });
  if (new Set(rows.map(r => r.id)).size !== rows.length) fail();
  const active = new Set<string>(), counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.projectId, (counts.get(row.projectId) ?? 0) + 1);
    if (counts.get(row.projectId)! > 1000) fail();
    if (row.retractedAt !== null) continue;
    const key = JSON.stringify([row.projectId, row.sourceId, row.spanId, row.claim.evidenceQuote, row.claim.statement]);
    if (active.has(key)) fail(); active.add(key);
  }
  return { externalClaims: rows };
}

export async function verifyExternalClaimHashes(data: ExternalClaimData, review: ReviewData) {
  for (const row of data.externalClaims) {
    const assessment = review.reviewRuns.find(r => r.id === row.runId)?.external?.assessments.find(a => a.pairId === row.pairId);
    if (!assessment || await externalAssessmentHash(assessment) !== row.assessmentHash || await externalClaimHash(row) !== row.recordHash)
      throw new Error('외부 주장 채택 hash가 일치하지 않습니다. 기존 작업공간을 유지합니다.');
  }
}
