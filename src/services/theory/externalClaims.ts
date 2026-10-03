import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import type { ContextEvidence, ReferenceData } from '../retrieval/types';
import { hashText } from './blocks';
import { assertExternalReviewCurrent, verifyExternalHashes, type ExternalAssessment } from './externalReview';
import { externalAssessmentHash } from './relationValidation';
import { assertProjectSources } from './projectSources';
import type { ReviewData } from './reviewTypes';
import type { TheoryData } from './types';

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

export async function prepareExternalClaimAcceptance(runId: string, pairId: string, db: QaxiomDatabase = qaxiomDatabase) {
  const run = await db.review_runs.get(runId);
  if (!run) throw new Error('외부 대조 결과가 없습니다.');
  const state = await assertExternalReviewCurrent(run, db);
  const pair = run.external!.context.pairs.find(p => p.id === pairId), assessment = run.external!.assessments.find(a => a.pairId === pairId);
  const evidence = run.external!.context.evidence.find(e => e.citationId === pair?.citationId);
  if (!pair || !assessment?.referenceClaim || !evidence || !run.external!.checkedPairIds.includes(pairId)) throw new Error('원문 인용이 있는 외부 주장 후보만 채택할 수 있습니다.');
  const projectId = run.external!.context.projectScope?.projectId;
  if (!projectId || state.snapshot.document.projectId !== projectId) throw new Error('프로젝트 소속이 변경되었습니다. 다시 대조하세요.');
  const candidate = structuredClone(assessment.referenceClaim);
  return { runId, pairId, projectId, documentId: run.documentId, assessmentHash: await externalAssessmentHash(assessment),
    sourceId: evidence.sourceId, sourceHash: evidence.sourceHash, spanId: evidence.span.id, spanHash: evidence.span.contentHash,
    sourceName: evidence.name, page: evidence.span.page ?? null, candidate, runSnapshot: JSON.stringify(run),
    documentSnapshot: JSON.stringify(state.snapshot.document), versionSnapshot: JSON.stringify(state.snapshot.version),
    sourceSnapshot: JSON.stringify(state.data.references.find(s => s.id === evidence.sourceId)),
    spanSnapshot: JSON.stringify(state.data.referenceSpans.find(s => s.id === evidence.span.id)),
    policySnapshot: JSON.stringify(state.project?.sourcePolicy ?? null), stateSignature: state.signature };
}
export type ExternalClaimPreview = Awaited<ReturnType<typeof prepareExternalClaimAcceptance>>;

export async function acceptExternalClaim(preview: ExternalClaimPreview, db: QaxiomDatabase = qaxiomDatabase) {
  const fresh = await prepareExternalClaimAcceptance(preview.runId, preview.pairId, db);
  if (JSON.stringify(fresh) !== JSON.stringify(preview)) throw new Error('외부 주장/원문/정책이 변경되었습니다. 미리보기를 다시 확인하세요.');
  const unsigned: UnsignedClaim = { id: crypto.randomUUID(), projectId: fresh.projectId, documentId: fresh.documentId,
    runId: fresh.runId, pairId: fresh.pairId, assessmentHash: fresh.assessmentHash, sourceId: fresh.sourceId,
    sourceHash: fresh.sourceHash, spanId: fresh.spanId, spanHash: fresh.spanHash, claim: fresh.candidate,
    acceptedAt: Date.now(), retractedAt: null, retractionNote: '' };
  const row: ExternalClaim = { ...unsigned, recordHash: await externalClaimHash(unsigned) };
  await db.transaction('rw', [db.external_claims, db.projects, db.theory_documents, db.document_versions, db.review_runs, db.references, db.reference_spans], async () => {
    const run = await db.review_runs.get(fresh.runId), document = await db.theory_documents.get(fresh.documentId);
    const project = document && await db.projects.get(document.projectId), version = await db.document_versions.get(run?.versionId ?? '');
    const source = await db.references.get(fresh.sourceId);
    const span = await db.reference_spans.get(fresh.spanId);
    if (!run || JSON.stringify(run) !== fresh.runSnapshot || !document || JSON.stringify(document) !== fresh.documentSnapshot
      || document.projectId !== fresh.projectId || document.currentVersionId !== run.versionId
      || !version || JSON.stringify(version) !== fresh.versionSnapshot || !project || !source || !span
      || JSON.stringify(source) !== fresh.sourceSnapshot || JSON.stringify(span) !== fresh.spanSnapshot
      || source.id !== fresh.sourceId || source.contentHash !== fresh.sourceHash || source.role !== 'external' || source.originVersionId !== null
      || span.sourceId !== source.id || span.contentHash !== fresh.spanHash || !span.text.includes(fresh.candidate.evidenceQuote)
      || (await db.document_versions.toArray()).some(v => v.contentHash === source.contentHash)) throw new Error('외부 주장 원문/정본/독립 출처가 변경되었습니다.');
    assertProjectSources(project, [source.id]);
    if (JSON.stringify(project.sourcePolicy ?? null) !== fresh.policySnapshot) throw new Error('프로젝트 자료 정책이 변경되었습니다.');
    const existing = await db.external_claims.where('projectId').equals(fresh.projectId).toArray();
    if (existing.length >= 1000 || await db.external_claims.count() >= 10000) throw new Error('외부 주장 채택 한도를 넘었습니다.');
    if (existing.some(c => c.retractedAt === null && c.sourceId === row.sourceId && c.spanId === row.spanId
      && c.claim.evidenceQuote === row.claim.evidenceQuote && c.claim.statement === row.claim.statement)) throw new Error('같은 외부 주장이 이미 채택되었습니다.');
    await db.external_claims.add(row);
  });
  return row;
}

export async function retractExternalClaim(id: string, note: string, db: QaxiomDatabase = qaxiomDatabase) {
  if (!note.trim() || note.length > 2000) throw new Error('철회 사유를 1–2,000자로 입력하세요.');
  const before = await db.external_claims.get(id);
  if (!before || before.retractedAt !== null) throw new Error('외부 주장 채택이 없거나 이미 철회되었습니다.');
  if (await externalClaimHash(before) !== before.recordHash) throw new Error('외부 주장 기록 hash가 일치하지 않습니다.');
  const unsigned = { ...before, retractedAt: Date.now(), retractionNote: note.trim() };
  const after = { ...unsigned, recordHash: await externalClaimHash(unsigned) };
  await db.transaction('rw', db.external_claims, async () => {
    if (JSON.stringify(await db.external_claims.get(id)) !== JSON.stringify(before)) throw new Error('다른 탭에서 외부 주장 기록을 변경했습니다.');
    await db.external_claims.put(after);
  });
  return after;
}

export type ProjectExternalClaimStatus = 'current' | 'retracted' | 'document_moved' | 'version_stale' | 'policy_changed' | 'source_changed';
export interface ProjectExternalClaimEntry {
  row: ExternalClaim;
  status: ProjectExternalClaimStatus;
  sourceName: string;
  documentTitle: string;
  evidence: ContextEvidence;
}

/** Project-scoped local ledger view. Historical claims are never promoted to active evidence by this query. */
export async function loadProjectExternalClaims(projectId: string, db: QaxiomDatabase = qaxiomDatabase): Promise<ProjectExternalClaimEntry[]> {
  if (!projectId.trim()) throw new Error('프로젝트를 선택하세요.');
  const state = await db.transaction('r', [db.projects, db.external_claims, db.theory_documents, db.document_versions, db.review_runs, db.references, db.reference_spans], async () => {
    const project = await db.projects.get(projectId);
    if (!project) throw new Error('현재 프로젝트가 없습니다.');
    const rows = await db.external_claims.where('projectId').equals(projectId).toArray();
    const runIds = [...new Set(rows.map(r => r.runId))], documentIds = [...new Set(rows.map(r => r.documentId))];
    const sourceIds = [...new Set(rows.map(r => r.sourceId))], spanIds = [...new Set(rows.map(r => r.spanId))];
    return { project, rows, runs: await db.review_runs.bulkGet(runIds), documents: await db.theory_documents.bulkGet(documentIds),
      sources: await db.references.bulkGet(sourceIds), spans: await db.reference_spans.bulkGet(spanIds), versions: await db.document_versions.toArray() };
  });
  const runs = state.runs.filter((r): r is NonNullable<typeof r> => !!r);
  await verifyExternalHashes(runs);
  await verifyExternalClaimHashes({ externalClaims: state.rows }, { reviewRuns: runs });
  const versions = new Map(state.versions.map(v => [v.id, v]));
  const documents = new Map(state.documents.filter((d): d is NonNullable<typeof d> => !!d).map(d => [d.id, d]));
  const sources = new Map(state.sources.filter((s): s is NonNullable<typeof s> => !!s).map(s => [s.id, s]));
  const spans = new Map(state.spans.filter((s): s is NonNullable<typeof s> => !!s).map(s => [s.id, s]));
  const ownHashes = new Set(state.versions.map(v => v.contentHash));
  const policyHash = state.project.sourcePolicy ? await hashText(JSON.stringify(state.project.sourcePolicy)) : null;
  const sourceHashes = new Map(await Promise.all([...sources.values()].map(async source => [source.id, await hashText(source.text)] as const)));
  const spanHashes = new Map(await Promise.all([...spans.values()].map(async span => [span.id, await hashText(span.text)] as const)));
  return state.rows.map(row => {
    const run = runs.find(r => r.id === row.runId), pair = run?.external?.context.pairs.find(p => p.id === row.pairId);
    const evidence = run?.external?.context.evidence.find(e => e.citationId === pair?.citationId);
    if (!run || !pair || !evidence || run.external?.context.projectScope?.projectId !== projectId
      || evidence.sourceId !== row.sourceId || evidence.sourceHash !== row.sourceHash
      || evidence.span.id !== row.spanId || evidence.span.contentHash !== row.spanHash) fail();
    const document = documents.get(row.documentId), source = sources.get(row.sourceId), span = spans.get(row.spanId);
    const frozenPolicy = run.external!.context.projectScope;
    const status: ProjectExternalClaimStatus = row.retractedAt !== null ? 'retracted'
      : document?.projectId !== projectId ? 'document_moved'
      : document.currentVersionId !== run.versionId ? 'version_stale'
      : frozenPolicy?.policyRevision !== (state.project.sourcePolicy?.revision ?? null) || frozenPolicy?.policyHash !== policyHash
        || !!state.project.sourcePolicy && !state.project.sourcePolicy.allowedSourceIds.includes(row.sourceId) ? 'policy_changed'
      : !source || !span || source.role !== 'external' || source.originVersionId !== null || ownHashes.has(source.contentHash)
        || source.contentHash !== row.sourceHash || sourceHashes.get(source.id) !== row.sourceHash
        || span.sourceId !== source.id || span.contentHash !== row.spanHash || spanHashes.get(span.id) !== row.spanHash
        || source.text.slice(span.startOffset, span.endOffset) !== span.text ? 'source_changed' : 'current';
    return { row, status, sourceName: evidence.name, documentTitle: versions.get(run.versionId)?.title ?? '과거 문서', evidence };
  }).sort((a, b) => b.row.acceptedAt - a.row.acceptedAt || a.row.id.localeCompare(b.row.id));
}
