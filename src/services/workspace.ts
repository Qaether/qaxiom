import type { ChatSession, DocumentChatContext, WikiPage } from '../types';
import {
  type DocumentChunkRecord,
  type DocumentRecord,
  type JobRecord,
  type MessageRecord,
  QaxiomDatabase,
  qaxiomDatabase,
  type SessionRecord,
  type SourceSpanRecord,
  loadSessionsFromDatabase,
  resetPersistenceState,
  flushSessionWrites
} from './database';
import type { TheoryData } from './theory/types';
import type { ReviewData } from './theory/reviewTypes';
import { parseReviewData } from './theory/reviewValidation';
import { parseCampaigns, type ReviewCampaign } from './theory/campaigns';
import { reviewSkeleton } from './theory/reviews';
import { parseTheoryData, verifyTheoryHashes } from './theory/validation';
import type { ReferenceData } from './retrieval/types';
import { parseContextBundle, parseReferenceData, verifyReferenceHashes } from './retrieval/validation';
import { decodePdfAsset, encodePdfAsset, parsePdfAssets, verifyPdfAssets } from './retrieval/pdfBackup';
import { spanLocation, type PdfAssetBackup } from './retrieval/pdfTypes';
import type { EmbeddingData } from './retrieval/embeddingTypes';
import { parseEmbeddingData, verifyEmbeddingHashes } from './retrieval/embeddingBackup';
import type { RelationData } from './theory/relationTypes';
import { parseRelationData, verifyRelationHashes } from './theory/relationValidation';
import { validateGraphRelations, verifyReviewGraphHashes } from './theory/reviewGraphValidation';
import { verifyPatchImpactHashes } from './theory/patchImpact';
import { externalContextHash, verifyExternalHashes } from './theory/externalReview';
import { parseExternalClaimData, verifyExternalClaimHashes, type ExternalClaimData } from './theory/externalClaims';
import { parseExternalClaimLinkData, verifyExternalClaimLinkHashes, type ExternalClaimLinkData } from './theory/externalClaimLinks';
import { verifyDocumentContext } from './documentChat';
import { EMPTY_CONTRACT } from './theory/types';
import { parseAnalysisRuns, type AnalysisRun } from './theory/analysis';

export const WORKSPACE_FORMAT = 'qaxiom-workspace';
export const WORKSPACE_VERSION = 24;

export interface WorkspaceMarkdownDocument {
  sessionId: string;
  filename: string;
  content: string;
}

export interface WorkspaceBundle {
  format: typeof WORKSPACE_FORMAT;
  version: typeof WORKSPACE_VERSION;
  exportedAt: string;
  data: TheoryData & ReferenceData & ReviewData & EmbeddingData & RelationData & ExternalClaimData & ExternalClaimLinkData & {
    sessions: SessionRecord[];
    messages: MessageRecord[];
    documents: DocumentRecord[];
    documentChunks: DocumentChunkRecord[];
    wikiPages: WikiPage[];
    sourceSpans: SourceSpanRecord[];
    jobs: JobRecord[];
    pdfAssets: PdfAssetBackup[];
    reviewCampaigns: ReviewCampaign[];
    analysisRuns: AnalysisRun[];
  };
  markdown: WorkspaceMarkdownDocument[];
}

function safeFilename(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
  return normalized || 'qaxiom-session';
}

export function sessionToMarkdown(session: ChatSession): string {
  const lines = [
    `# ${session.title}`,
    `> 연구 모드: ${session.researchMode}`,
    `> 생성일: ${new Date(session.createdAt).toISOString()}`,
    `> 모델: ${session.selectedModel}`,
    '',
    '---',
    ''
  ];

  for (const message of session.messages) {
    const speaker = message.role === 'user'
      ? '### Researcher'
      : `### Qaxiom (${message.model || 'Assistant'})`;
    lines.push(speaker, '', message.content, '');
    if (message.contextBundle) {
      lines.push('#### 전송한 원문 근거', '');
      if (message.contextBundle.retriever === 'graph-canonical-v1') lines.push('정본 단독 문맥 — 레퍼런스 원문 0개. 독립 외부 근거 없는 답변이며 정합성 증명이 아니다.', '');
      if (message.contextBundle.graph) {
        lines.push('#### 전송 당시 정본 그래프', '', '자체 문서·승인 관계는 외부 증거나 검사 완료가 아니다.', '', '```json', JSON.stringify(message.contextBundle.graph.context, null, 2), '```', '');
        message.contextBundle.graph.blocks.forEach((block, index) => lines.push(`[[G${index + 1}]] 블록 ${block.id} · SHA-256 ${block.contentHash}`, '', ...block.text.split('\n').map(line => `> ${line}`), ''));
      }
      if (message.contextBundle.hybrid) {
        const trace = message.contextBundle.hybrid;
        lines.push(`검색: BM25 + 벡터 RRF(k=60) · 세대 ${trace.spaceId} · ${trace.model}/${trace.dimensions}차원 · 제공사 revision 미확인`, '',
          `의미 색인 구간: ${trace.coveredSpanIds.join(', ') || '없음'}`, `의미 미색인 구간: ${trace.missingSpanIds.join(', ') || '없음'} (BM25에서는 검색)`, '');
        if (trace.manifestHash) lines.push(`검증한 완성 manifest SHA-256 ${trace.manifestHash} · 검색 당시 전환 번호 ${trace.activationRevision}`, '');
      }
      const assembly = message.contextBundle.assembly;
      const projectScope = message.contextBundle.projectScope;
      if (projectScope) lines.push(`전송 당시 프로젝트 ${projectScope.projectId} · 정책 ${projectScope.policyScope ?? '미설정'} · 개정 ${projectScope.policyRevision ?? '없음'} · 정책 SHA-256 ${projectScope.policyHash ?? '없음'}`, '', '현재 정책이나 접근 제어의 증명이 아닌 고정 전송 기록이다.', '');
      if (assembly) {
        lines.push(`부모 문맥 ${assembly.parentSpanIds.length}개 · 예산상 미전송 구간: ${assembly.omittedSpanIds.join(', ') || '없음'}`, '');
        for (const omission of assembly.omissions) lines.push(`미전송: ${omission.name} · ${spanLocation(omission)} · ${omission.reason}`, '');
        if (assembly.research) {
          const research = assembly.research;
          lines.push(`필수 연구 기준: ${research.title} · v${research.number} · version ${research.versionId} · 본문 SHA-256 ${research.contentHash}`, '',
            ...JSON.stringify(research.contract, null, 2).split('\n').map(line => `> ${line}`), '',
            ...(research.contractAnchors ? [`정본 원문 블록 연결: ${JSON.stringify(research.contractAnchors)} · 연결 블록 본문은 선택되지 않았다면 미전송`, ''] : []),
            `비어 있는 연구 기준: ${research.emptyFields.join(', ') || '없음'} · 독립 외부 증거 아님`, '');
        } else lines.push('연구 기준 미첨부 — 전제의 완전성 미확인', '');
      }
      for (const item of message.contextBundle.evidence) {
        lines.push(`[[${item.citationId}]] ${item.name} · ${spanLocation(item.span)} · ${item.role} · source ${item.sourceId} · SHA-256 ${item.sourceHash}`, '',
          ...item.span.text.split('\n').map(line => `> ${line}`), '');
        if (item.pdf) lines.push(`PDF 원본 SHA-256 ${item.pdf.fileHash} · 추출기 ${item.pdf.engineVersion} · 텍스트 없는 페이지: ${item.pdf.emptyPages.join(', ') || '없음'}`, '');
      }
    }
    lines.push('---', '');
  }
  return lines.join('\n');
}

export async function createWorkspaceBundle(
  database: QaxiomDatabase = qaxiomDatabase
): Promise<WorkspaceBundle> {
  await flushSessionWrites();
  return database.transaction('r', database.tables, async () => {
  const [sessions, messages, documents, documentChunks, wikiPages, sourceSpans, jobs, hydratedSessions] =
    await Promise.all([
      database.sessions.orderBy('position').toArray(),
      database.messages.toArray(),
      database.documents.toArray(),
      database.document_chunks.toArray(),
      database.wiki_pages.toArray(),
      database.source_spans.toArray(),
      database.jobs.toArray(),
      loadSessionsFromDatabase(database)
    ]);

  return {
    format: WORKSPACE_FORMAT,
    version: WORKSPACE_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      sessions: sessions.map(session => ({ ...session, documentId: session.documentId ?? null })), messages, documents, documentChunks, wikiPages, sourceSpans, jobs,
      projects: await database.projects.toArray(),
      theoryDocuments: await database.theory_documents.toArray(),
      documentVersions: await database.document_versions.toArray(),
      documentBlocks: await database.document_blocks.toArray(),
      references: await database.references.toArray(),
      referenceSpans: await database.reference_spans.toArray(),
      pdfAssets: (await database.pdf_assets.toArray()).map(encodePdfAsset),
      reviewRuns: await database.review_runs.toArray(),
      analysisRuns: await database.analysis_runs.toArray(),
      reviewCampaigns: await database.review_campaigns.toArray(),
      embeddingSpaces: await database.embedding_spaces.toArray(),
      embeddingVectors: await database.embedding_vectors.toArray(),
      embeddingManifests: await database.embedding_manifests.toArray(),
      embeddingActivations: await database.embedding_activations.toArray(),
      researchRelations: await database.research_relations.toArray(),
      externalClaims: await database.external_claims.toArray(),
      externalClaimLinks: await database.external_claim_links.toArray()
    },
    markdown: hydratedSessions.map(session => ({
      sessionId: session.id,
      filename: `${safeFilename(session.title)}.md`,
      content: sessionToMarkdown(session)
    }))
  };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value) throw new Error(`필수 문자열 필드가 없습니다: ${key}`);
  return value;
}

function requireText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`필수 텍스트 필드가 없습니다: ${key}`);
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`필수 숫자 필드가 없습니다: ${key}`);
  }
  return value;
}

function requireRecordArray(value: unknown, key: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(item => !isRecord(item))) {
    throw new Error(`작업공간의 ${key} 목록이 올바르지 않습니다.`);
  }
  return value;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} ID가 중복되었습니다.`);
}

function parseDocumentChatContext(value: unknown, theory: TheoryData): DocumentChatContext {
  const contract = isRecord(value) ? value.contract : undefined;
  if (!isRecord(value) || typeof value.documentId !== 'string' || typeof value.title !== 'string'
    || typeof value.markdown !== 'string' || typeof value.contentHash !== 'string'
    || typeof value.capturedAt !== 'number' || !Number.isFinite(value.capturedAt)
    || value.versionId !== null && typeof value.versionId !== 'string'
    || !isRecord(contract)
    || Object.keys(EMPTY_CONTRACT).some(key => typeof contract[key] !== 'string')) {
    throw new Error('대화의 기준 연구노트 문맥 형식이 올바르지 않습니다.');
  }
  if (!theory.theoryDocuments.some(document => document.id === value.documentId)
    || value.versionId && !theory.documentVersions.some(version => version.id === value.versionId && version.documentId === value.documentId)) {
    throw new Error('대화의 기준 연구노트 또는 버전 참조가 올바르지 않습니다.');
  }
  return value as unknown as DocumentChatContext;
}

export function parseWorkspaceBundle(value: unknown): WorkspaceBundle {
  if (!isRecord(value) || value.format !== WORKSPACE_FORMAT || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, WORKSPACE_VERSION].includes(Number(value.version)) || typeof value.version !== 'number') {
    throw new Error('지원하지 않는 Qaxiom 작업공간 형식 또는 버전입니다.');
  }
  if (typeof value.exportedAt !== 'string' || !isRecord(value.data)) {
    throw new Error('작업공간 메타데이터가 올바르지 않습니다.');
  }

  const sessionValues = requireRecordArray(value.data.sessions, 'sessions');
  const messageValues = requireRecordArray(value.data.messages, 'messages');
  const documentValues = requireRecordArray(value.data.documents, 'documents');
  const chunkValues = requireRecordArray(value.data.documentChunks, 'documentChunks');
  const wikiValues = requireRecordArray(value.data.wikiPages, 'wikiPages');
  const spanValues = requireRecordArray(value.data.sourceSpans, 'sourceSpans');
  const jobValues = requireRecordArray(value.data.jobs, 'jobs');
  const theory = value.version === 1
    ? { projects: [], theoryDocuments: [], documentVersions: [], documentBlocks: [] }
    : parseTheoryData(value.data, Number(value.version) >= 22);
  const pdfAssets = Number(value.version) >= 4 ? parsePdfAssets(value.data.pdfAssets) : [];
  const references = Number(value.version) >= 3 ? parseReferenceData(value.data, theory.documentVersions, pdfAssets) : { references: [], referenceSpans: [] };
  if (theory.projects.some(p => p.sourcePolicy?.allowedSourceIds.some(id => !references.references.some(s => s.id === id)))) throw new Error('프로젝트 허용 자료 참조가 올바르지 않습니다. 기존 작업공간을 유지합니다.');
  const review = Number(value.version) >= 5 ? parseReviewData(value.data, theory, references) : { reviewRuns: [] };
  const analysisRuns = Number(value.version) >= 24 ? parseAnalysisRuns(value.data.analysisRuns, theory) : [];
  const reviewCampaigns = Number(value.version) >= 6 ? parseCampaigns(value.data.reviewCampaigns, theory, review.reviewRuns, references) : [];
  const embeddings = Number(value.version) >= 7 ? parseEmbeddingData(value.data, references, Number(value.version) >= 8)
    : { embeddingSpaces: [], embeddingVectors: [], embeddingManifests: [], embeddingActivations: [] };
  const relations = Number(value.version) >= 9 ? parseRelationData(value.data, theory, review, references) : { researchRelations: [] };
  const externalClaims = Number(value.version) >= 20 ? parseExternalClaimData(value.data, theory, review, references) : { externalClaims: [] };
  const externalClaimLinks = Number(value.version) >= 21 ? parseExternalClaimLinkData(value.data, externalClaims) : { externalClaimLinks: [] };
  for (const graph of [...review.reviewRuns.map(r => r.graph), ...reviewCampaigns.flatMap(c => c.attempts.map(a => a.graph)), ...reviewCampaigns.flatMap(c => c.plan?.graphContexts ?? []), ...review.reviewRuns.flatMap(r => r.patches.flatMap(p => p.impact ? [p.impact.graph] : []))]) {
    if (graph) validateGraphRelations(graph, relations);
  }

  const sessions = sessionValues.map(record => ({
    id: requireString(record, 'id'),
    documentId: Number(value.version) >= 23
      ? record.documentId === null ? null : requireString(record, 'documentId') : null,
    position: requireNumber(record, 'position'),
    title: requireString(record, 'title'),
    createdAt: requireNumber(record, 'createdAt'),
    updatedAt: requireNumber(record, 'updatedAt'),
    researchMode: requireString(record, 'researchMode') as SessionRecord['researchMode'],
    selectedModel: requireString(record, 'selectedModel')
  }));
  const messages = messageValues.map(record => ({
    ...record,
    id: requireString(record, 'id'),
    sessionId: requireString(record, 'sessionId'),
    position: requireNumber(record, 'position'),
    role: requireString(record, 'role') as MessageRecord['role'],
    content: requireText(record, 'content'),
    timestamp: requireNumber(record, 'timestamp'),
    ...(record.contextBundle !== undefined ? { contextBundle: parseContextBundle(record.contextBundle, references, theory.documentVersions, embeddings, { theory, reviews: review, relations }) } : {}),
    ...(Number(value.version) >= 23 && record.documentContext !== undefined
      ? { documentContext: parseDocumentChatContext(record.documentContext, theory) } : {})
  } as MessageRecord));
  const documents = documentValues.map(record => ({
    ...record,
    id: requireString(record, 'id'),
    name: requireString(record, 'name'),
    mimeType: requireString(record, 'mimeType'),
    size: requireNumber(record, 'size'),
    createdAt: requireNumber(record, 'createdAt'),
    updatedAt: requireNumber(record, 'updatedAt'),
    status: requireString(record, 'status') as DocumentRecord['status']
  } as DocumentRecord));
  const documentChunks = chunkValues.map(record => ({
    ...record,
    id: requireString(record, 'id'),
    documentId: requireString(record, 'documentId'),
    position: requireNumber(record, 'position'),
    text: requireText(record, 'text')
  } as DocumentChunkRecord));
  const wikiPages = wikiValues.map(record => ({
    ...record,
    id: requireString(record, 'id'),
    title: requireString(record, 'title'),
    summary: typeof record.summary === 'string' ? record.summary : '',
    content: typeof record.content === 'string' ? record.content : '',
    tags: Array.isArray(record.tags) ? record.tags.filter(tag => typeof tag === 'string') : [],
    backlinks: Array.isArray(record.backlinks)
      ? record.backlinks.filter(link => typeof link === 'string')
      : [],
    createdAt: requireNumber(record, 'createdAt'),
    updatedAt: requireNumber(record, 'updatedAt')
  } as WikiPage));
  const sourceSpans = spanValues.map(record => ({
    ...record,
    id: requireString(record, 'id'),
    documentId: requireString(record, 'documentId'),
    startOffset: requireNumber(record, 'startOffset'),
    endOffset: requireNumber(record, 'endOffset'),
    quote: requireString(record, 'quote')
  } as SourceSpanRecord));
  const jobs = jobValues.map(record => ({
    ...record,
    id: requireString(record, 'id'),
    type: requireString(record, 'type'),
    status: requireString(record, 'status') as JobRecord['status'],
    createdAt: requireNumber(record, 'createdAt'),
    updatedAt: requireNumber(record, 'updatedAt')
  } as JobRecord));

  assertUnique(sessions.map(record => record.id), '세션');
  assertUnique(messages.map(record => `${record.sessionId}\u0000${record.id}`), '메시지');
  assertUnique(documents.map(record => record.id), '문서');
  assertUnique(documentChunks.map(record => record.id), '문서 청크');
  assertUnique(wikiPages.map(record => record.id), '위키');
  assertUnique(sourceSpans.map(record => record.id), '출처');
  assertUnique(jobs.map(record => record.id), '작업');

  const sessionIds = new Set(sessions.map(record => record.id));
  const theoryIds = new Set(theory.theoryDocuments.map(record => record.id));
  if (sessions.some(record => record.documentId !== null && !theoryIds.has(record.documentId))) {
    throw new Error('대화 세션의 기준 연구노트가 존재하지 않습니다.');
  }
  const sessionDocuments = new Map(sessions.map(record => [record.id, record.documentId]));
  if (messages.some(record => record.documentContext && record.documentContext.documentId !== sessionDocuments.get(record.sessionId))) {
    throw new Error('대화 메시지의 기준 연구노트가 세션과 다릅니다.');
  }
  const documentIds = new Set(documents.map(record => record.id));
  if (messages.some(record => !sessionIds.has(record.sessionId))) {
    throw new Error('존재하지 않는 세션을 참조하는 메시지가 있습니다.');
  }
  if (documentChunks.some(record => !documentIds.has(record.documentId))) {
    throw new Error('존재하지 않는 문서를 참조하는 청크가 있습니다.');
  }
  if (sourceSpans.some(record => !documentIds.has(record.documentId))) {
    throw new Error('존재하지 않는 문서를 참조하는 출처가 있습니다.');
  }

  return {
    format: WORKSPACE_FORMAT,
    version: WORKSPACE_VERSION,
    exportedAt: value.exportedAt,
    data: { sessions, messages, documents, documentChunks, wikiPages, sourceSpans, jobs, ...theory, ...references, ...review, ...embeddings, ...relations, ...externalClaims, ...externalClaimLinks, reviewCampaigns, analysisRuns, pdfAssets: pdfAssets.map(encodePdfAsset) },
    markdown: []
  };
}

export async function restoreWorkspaceBundle(
  input: unknown,
  database: QaxiomDatabase = qaxiomDatabase
): Promise<WorkspaceBundle> {
  const bundle = parseWorkspaceBundle(input);
  await verifyTheoryHashes(bundle.data);
  for (const message of bundle.data.messages) if (message.documentContext) await verifyDocumentContext(message.documentContext);
  await verifyReferenceHashes(bundle.data);
  await verifyEmbeddingHashes(bundle.data);
  await verifyRelationHashes(bundle.data, bundle.data.reviewRuns);
  await verifyPatchImpactHashes(bundle.data.reviewRuns);
  await verifyExternalHashes(bundle.data.reviewRuns);
  await verifyExternalClaimHashes(bundle.data, bundle.data);
  await verifyExternalClaimLinkHashes(bundle.data, bundle.data);
  for (const c of bundle.data.reviewCampaigns) for (const a of c.attempts) if (a.external && await externalContextHash(a.external) !== a.external.contextHash) throw new Error('외부 대조 예약의 문맥 hash가 일치하지 않습니다.');
  await verifyReviewGraphHashes([...bundle.data.reviewRuns.flatMap(r => r.graph ? [r.graph] : []),
    ...bundle.data.messages.flatMap(m => m.contextBundle?.graph ? [m.contextBundle.graph.context] : []),
    ...bundle.data.reviewCampaigns.flatMap(c => c.attempts.flatMap(a => a.graph ? [a.graph] : [])),
    ...bundle.data.reviewCampaigns.flatMap(c => c.plan?.graphContexts ?? []),
    ...bundle.data.reviewRuns.flatMap(r => r.patches.flatMap(p => p.impact ? [p.impact.graph] : []))]);
  bundle.data.embeddingSpaces = bundle.data.embeddingSpaces.map(space => ({ ...space, runId: null, deadlineAt: null }));
  const pdfAssets = bundle.data.pdfAssets.map(decodePdfAsset);
  await verifyPdfAssets(pdfAssets);
  // A backup does not transfer ownership of an external request. Never auto-retry it.
  for (const campaign of bundle.data.reviewCampaigns) {
    const attempt = campaign.attempts.find(a => a.runId === null);
    if (!attempt) continue;
    const version = bundle.data.documentVersions.find(v => v.id === attempt.versionId)!;
    const document = bundle.data.theoryDocuments.find(d => d.id === campaign.documentId)!;
    const blocks = bundle.data.documentBlocks.filter(b => b.versionId === version.id);
    const run = reviewSkeleton({ document, version, blocks, history: bundle.data.documentVersions.filter(v => v.documentId === document.id) }, 'llm-v1', [], attempt.modelId);
    run.status = 'stopped'; run.outcome = 'insufficient';
    if (attempt.graph) run.graph = structuredClone(attempt.graph);
    if (attempt.external) { run.checker = 'external-v1'; run.external = { context: attempt.external, checkedPairIds: [], assessments: [] }; }
    run.error = '백업 복원으로 실행 소유권이 종료되었습니다. 원격 결과와 실제 제공사 비용은 미확인입니다.';
    attempt.elapsedMs = attempt.deadlineAt - attempt.startedAt; attempt.runId = run.id;
    bundle.data.reviewRuns.push(run);
  }
  await flushSessionWrites();
  const tables = [
    database.sessions,
    database.messages,
    database.documents,
    database.document_chunks,
    database.wiki_pages,
    database.source_spans,
    database.jobs,
    database.projects,
    database.theory_documents,
    database.document_versions,
    database.document_blocks,
    database.references,
    database.reference_spans,
    database.pdf_assets,
    database.review_runs,
    database.analysis_runs,
    database.review_campaigns,
    database.embedding_spaces,
    database.embedding_vectors,
    database.embedding_manifests,
    database.embedding_activations,
    database.research_relations,
    database.external_claims,
    database.external_claim_links
  ];

  await database.transaction('rw', tables, async () => {
    await Promise.all(tables.map(table => table.clear()));
    if (bundle.data.sessions.length) await database.sessions.bulkAdd(bundle.data.sessions);
    if (bundle.data.messages.length) await database.messages.bulkAdd(bundle.data.messages);
    if (bundle.data.documents.length) await database.documents.bulkAdd(bundle.data.documents);
    if (bundle.data.documentChunks.length) await database.document_chunks.bulkAdd(bundle.data.documentChunks);
    if (bundle.data.wikiPages.length) await database.wiki_pages.bulkAdd(bundle.data.wikiPages);
    if (bundle.data.sourceSpans.length) await database.source_spans.bulkAdd(bundle.data.sourceSpans);
    if (bundle.data.jobs.length) await database.jobs.bulkAdd(bundle.data.jobs);
    if (bundle.data.projects.length) await database.projects.bulkAdd(bundle.data.projects);
    if (bundle.data.theoryDocuments.length) await database.theory_documents.bulkAdd(bundle.data.theoryDocuments);
    if (bundle.data.documentVersions.length) await database.document_versions.bulkAdd(bundle.data.documentVersions);
    if (bundle.data.documentBlocks.length) await database.document_blocks.bulkAdd(bundle.data.documentBlocks);
    if (bundle.data.references.length) await database.references.bulkAdd(bundle.data.references);
    if (bundle.data.referenceSpans.length) await database.reference_spans.bulkAdd(bundle.data.referenceSpans);
    if (pdfAssets.length) await database.pdf_assets.bulkAdd(pdfAssets);
    if (bundle.data.reviewRuns.length) await database.review_runs.bulkAdd(bundle.data.reviewRuns);
    if (bundle.data.analysisRuns.length) await database.analysis_runs.bulkAdd(bundle.data.analysisRuns);
    if (bundle.data.reviewCampaigns.length) await database.review_campaigns.bulkAdd(bundle.data.reviewCampaigns);
    if (bundle.data.embeddingSpaces.length) await database.embedding_spaces.bulkAdd(bundle.data.embeddingSpaces);
    if (bundle.data.embeddingVectors.length) await database.embedding_vectors.bulkAdd(bundle.data.embeddingVectors);
    if (bundle.data.embeddingManifests.length) await database.embedding_manifests.bulkAdd(bundle.data.embeddingManifests);
    if (bundle.data.embeddingActivations.length) await database.embedding_activations.bulkAdd(bundle.data.embeddingActivations);
    if (bundle.data.researchRelations.length) await database.research_relations.bulkAdd(bundle.data.researchRelations);
    if (bundle.data.externalClaims.length) await database.external_claims.bulkAdd(bundle.data.externalClaims);
    if (bundle.data.externalClaimLinks.length) await database.external_claim_links.bulkAdd(bundle.data.externalClaimLinks);
  });

  resetPersistenceState();
  return bundle;
}

export function serializeWorkspaceBundle(bundle: WorkspaceBundle): string {
  const serialized = JSON.stringify(bundle, null, 2);
  if (new TextEncoder().encode(serialized).byteLength > 100 * 1024 * 1024) throw new Error('PDF 원본을 포함한 백업이 100 MB를 넘습니다. 분할 백업은 아직 지원하지 않습니다.');
  return serialized;
}
