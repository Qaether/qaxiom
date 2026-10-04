import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import type { TheorySnapshot, TheoryData } from './types';
import type { ReviewRun } from './reviewTypes';
import { prepareReviewRequest, reviewSkeleton } from './reviews';
import { hashText } from './blocks';
import { campaignStop, runStopReasons, STOP_REASONS, type CampaignStopReason } from './campaignPolicy';
import { assertGraphReviewCurrent, prepareGraphReview, readGraphReviewState, type GraphReviewPreparation } from './reviewGraph';
import type { ReviewGraphContext } from './reviewGraphTypes';
import { parseReviewGraph } from './reviewGraphValidation';
import { assertExternalCurrent, externalStateSignature, parseExternalContext, parseExternalResponse, type ExternalPreparation, type ExternalReviewContext } from './externalReview';
import type { ReferenceData } from '../retrieval/types';

export interface ReviewAttempt {
  external?: ExternalReviewContext;
  externalStateHash?: string;
  graph?: ReviewGraphContext;
  token: string;
  versionId: string;
  modelId: string;
  blockIds: string[];
  startedAt: number;
  deadlineAt: number;
  elapsedMs: number;
  runId: string | null;
}
export interface ReviewCampaign {
  id: string;
  documentId: string;
  activeDocumentId: string | null;
  createdAt: number;
  maxRequests: number;
  maxElapsedMs: number;
  attempts: ReviewAttempt[];
  plan: { versionId: string; batches: string[][]; graphContexts?: ReviewGraphContext[] } | null;
  confirmations?: { runId: string; reasons: CampaignStopReason[]; note: string; createdAt: number }[];
  closure?: { versionId: string; note: string; createdAt: number };
}

export async function getCampaign(documentId: string, db: QaxiomDatabase = qaxiomDatabase) {
  return db.review_campaigns.where('activeDocumentId').equals(documentId).first();
}
export async function ensureCampaign(documentId: string, db: QaxiomDatabase = qaxiomDatabase): Promise<ReviewCampaign> {
  return db.transaction('rw', [db.review_campaigns, db.theory_documents], async () => {
    const existing = await getCampaign(documentId, db);
    if (existing) return existing;
    if (!await db.theory_documents.get(documentId)) throw new Error('문서가 없습니다.');
    const campaign: ReviewCampaign = { id: crypto.randomUUID(), documentId, activeDocumentId: documentId, createdAt: Date.now(),
      maxRequests: 3, maxElapsedMs: 360000, attempts: [], plan: null };
    await db.review_campaigns.add(campaign); return campaign;
  });
}
export const activeAttempt = (campaign: ReviewCampaign) => campaign.attempts.find(attempt => attempt.runId === null);
export const spentTime = (campaign: ReviewCampaign) => campaign.attempts.reduce((sum, attempt) => sum + attempt.elapsedMs, 0);

export async function changeCampaignBudget(id: string, maxRequests: number, db: QaxiomDatabase = qaxiomDatabase) {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 100) throw new Error('요청 예산은 1–100회 정수여야 합니다.');
  return db.transaction('rw', db.review_campaigns, async () => {
    const campaign = await db.review_campaigns.get(id);
    if (!campaign || !campaign.activeDocumentId || campaign.closure || activeAttempt(campaign)) throw new Error('실행 중이거나 종료된 검토 예산은 변경할 수 없습니다.');
    campaign.maxRequests = maxRequests; campaign.maxElapsedMs = maxRequests * 120000;
    await db.review_campaigns.put(campaign); return campaign;
  });
}

export function planReviewBatches(snapshot: TheorySnapshot, selected: string[]): string[][] {
  reviewSkeleton(snapshot, 'llm-v1', selected, 'plan');
  if (!selected.length) throw new Error('분할 검토할 블록을 선택하세요.');
  const blockIds = snapshot.blocks.filter(block => selected.includes(block.id)).map(block => block.id);
  prepareReviewRequest(snapshot, blockIds);
  return [blockIds];
}
/** New plans use one confirmed request; historical split plans remain readable. No provider calls. */
export async function planGraphReviewBatches(snapshot: TheorySnapshot, selected: string[], db: QaxiomDatabase = qaxiomDatabase) {
  reviewSkeleton(snapshot, 'llm-v1', selected, 'plan');
  if (!selected.length) throw new Error('분할 검토할 블록을 선택하세요.');
  const initial = await readGraphReviewState(snapshot.document.id, db);
  const prepared: GraphReviewPreparation = await prepareGraphReview(snapshot, selected, db);
  if (prepared.stateSignature !== initial.signature) throw new Error('계획 중 승인 그래프/원문이 변경되었습니다. 다시 확인하세요.');
  if ((await readGraphReviewState(snapshot.document.id, db)).signature !== initial.signature) throw new Error('분할 중 승인 그래프/원문이 변경되었습니다.');
  return { batches: [prepared.graph.targetBlockIds], graphContexts: [prepared.graph], stateSignature: initial.signature };
}
export async function saveReviewPlan(id: string, snapshot: TheorySnapshot, selected: string[], db: QaxiomDatabase = qaxiomDatabase, includeGraph = false) {
  const graphPlan = includeGraph ? await planGraphReviewBatches(snapshot, selected, db) : null;
  const batches = graphPlan?.batches ?? planReviewBatches(snapshot, selected);
  return db.transaction('rw', [db.review_campaigns, db.theory_documents, db.document_versions, db.document_blocks, db.review_runs, db.research_relations], async () => {
    if (graphPlan && (await readGraphReviewState(snapshot.document.id, db)).signature !== graphPlan.stateSignature) throw new Error('승인 그래프/원문이 변경되어 계획을 저장하지 않습니다.');
    const campaign = await db.review_campaigns.get(id), document = await db.theory_documents.get(snapshot.document.id);
    if (!campaign || campaign.closure || campaign.activeDocumentId !== snapshot.document.id || activeAttempt(campaign) || document?.currentVersionId !== snapshot.version.id) throw new Error('검토 중이거나 문서 버전이 바뀌었습니다.');
    campaign.plan = { versionId: snapshot.version.id, batches, ...(graphPlan ? { graphContexts: graphPlan.graphContexts } : {}) }; await db.review_campaigns.put(campaign); return campaign;
  });
}

export function assertPlannedGraph(plan: ReviewCampaign['plan'], prepared: GraphReviewPreparation) {
  const contexts = plan?.graphContexts;
  if (!plan || !contexts || plan.versionId !== prepared.graph.versionId
    || contexts[0]?.graphFingerprint !== prepared.graph.graphFingerprint
    || !plan.batches.some(batch => prepared.graph.targetBlockIds.every(id => batch.includes(id)))) throw new Error('저장된 그래프 분할 계획이 변경되었습니다. 계획을 다시 저장하거나 수동 범위를 선택하세요.');
}

export async function reserveReviewAttempt(id: string, snapshot: TheorySnapshot, blockIds: string[], modelId: string, db: QaxiomDatabase = qaxiomDatabase, graph?: GraphReviewPreparation, external?: ExternalPreparation) {
  if (graph) graph = structuredClone(graph);
  if (external) external = structuredClone(external);
  if (external && graph) throw new Error('외부 대조와 내부 그래프 검토를 혼합하지 않습니다.');
  if (!modelId.trim()) throw new Error('검토 모델을 선택하세요.');
  if (external) {
    if (blockIds.length !== external.context.blocks.length || blockIds.some(id => !external.context.blocks.some(b => b.id === id))) throw new Error('외부 대조 예약 범위가 다릅니다.');
    await assertExternalCurrent(snapshot, external, db);
  } else prepareReviewRequest(snapshot, blockIds, graph?.graph);
  if (graph) await assertGraphReviewCurrent(snapshot, graph, db);
  const externalStateHash = external ? await hashText(external.stateSignature) : undefined;
  return db.transaction('rw', [db.projects, db.review_campaigns, db.theory_documents, db.document_versions, db.document_blocks, db.review_runs, db.research_relations, db.references, db.reference_spans, db.pdf_assets], async () => {
    if (graph && (await readGraphReviewState(snapshot.document.id, db)).signature !== graph.stateSignature) throw new Error('승인 그래프/원문이 변경되어 요청을 예약하지 않습니다.');
    if (external && await externalStateSignature(snapshot.document.id, external.context, db) !== external.stateSignature) throw new Error('외부 대조 출처/원문이 변경되어 요청을 예약하지 않습니다.');
    const campaign = await db.review_campaigns.get(id), document = await db.theory_documents.get(snapshot.document.id);
    if (!campaign || !campaign.activeDocumentId || campaign.documentId !== snapshot.document.id || document?.currentVersionId !== snapshot.version.id) throw new Error('검토 캠페인 또는 문서 버전이 바뀌었습니다.');
    if (campaign.closure) throw new Error('이번 검토는 사용자가 종료했습니다. 명시적으로 새 검토를 시작하세요.');
    if (activeAttempt(campaign)) throw new Error('이미 진행 중인 검토가 있습니다. 다른 탭의 실행이 끝나거나 실행 기한이 만료된 뒤 재개하세요.');
    if (campaignStop(campaign, await db.review_runs.where('documentId').equals(campaign.documentId).toArray())) throw new Error('검토 중단 사유와 다음 검사 조건을 확인한 뒤 재개하세요.');
    const remaining = campaign.maxElapsedMs - spentTime(campaign);
    if (campaign.attempts.length >= campaign.maxRequests || remaining <= 0) throw new Error('저장된 검토 회차/시간 예산이 소진되었습니다. 예산을 명시적으로 변경하세요.');
    const startedAt = Date.now();
    const attempt: ReviewAttempt = { token: crypto.randomUUID(), versionId: snapshot.version.id, modelId, blockIds: [...blockIds],
      ...(graph ? { graph: structuredClone(graph.graph) } : {}),
      ...(external ? { external: external.context, externalStateHash } : {}),
      startedAt, deadlineAt: startedAt + Math.min(120000, remaining), elapsedMs: 0, runId: null };
    campaign.attempts.push(attempt); await db.review_campaigns.put(campaign); return attempt;
  });
}

export async function finishReviewAttempt(id: string, token: string, run: ReviewRun, db: QaxiomDatabase = qaxiomDatabase) {
  const before = await db.review_campaigns.get(id);
  const pending = before ? activeAttempt(before) : null;
  const state = pending?.graph ? await readGraphReviewState(run.documentId, db) : null;
  const fingerprint = state ? await hashText(state.signature) : null;
  const externalState = pending?.external ? await externalStateSignature(run.documentId, pending.external, db) : null;
  const externalHash = externalState ? await hashText(externalState) : null;
  return db.transaction('rw', [db.projects, db.review_campaigns, db.review_runs, db.theory_documents, db.document_versions, db.document_blocks, db.research_relations, db.references, db.reference_spans, db.pdf_assets], async () => {
    const campaign = await db.review_campaigns.get(id), attempt = campaign && activeAttempt(campaign);
    if (!campaign?.activeDocumentId || !attempt || attempt.token !== token || run.modelId !== attempt.modelId || run.documentId !== campaign.documentId || run.versionId !== attempt.versionId
      || run.checker !== (attempt.external ? 'external-v1' : 'llm-v1') || run.checkedBlockIds.some(blockId => !attempt.blockIds.includes(blockId))) throw new Error('검토 실행 소유권/범위가 바뀌었습니다. 이전 실행 결과를 저장하지 않습니다.');
    if (attempt.external) {
      if (run.checkedBlockIds.length || run.claims.length || run.issues.length || run.patches.length || !run.external || run.outcome !== 'insufficient' || JSON.stringify(run.external.context) !== JSON.stringify(attempt.external)) throw new Error('외부 대조를 내부 검사로 승격하거나 예약 문맥을 변경할 수 없습니다.');
      parseExternalResponse(JSON.stringify({ ...run.external, limitations: run.limitations }), attempt.external);
      if (run.status === 'complete' && (externalHash !== attempt.externalStateHash || await externalStateSignature(run.documentId, attempt.external, db) !== externalState)) {
        run.status = 'failed'; run.outcome = 'insufficient'; run.error = '외부 대조 출처/정본이 전송 후 변경되었습니다. 결과를 승격하지 않습니다. 제공사 비용 미확인.';
        run.external.checkedPairIds = []; run.external.assessments = [];
      }
    } else if (run.external) throw new Error('내부 검토 예약에 외부 대조 결과를 저장할 수 없습니다.');
    if (run.graph && JSON.stringify(run.graph) !== JSON.stringify(attempt.graph)) throw new Error('검토 응답의 그래프 문맥이 예약한 요청과 다릅니다.');
    if (attempt.graph) run.graph = structuredClone(attempt.graph);
    if (attempt.graph?.proofCycleRelationIds.length && run.status === 'complete') {
      if (!run.limitations.some(text => text.startsWith('승인된 proof 의존 관계에 순환 후보'))) run.limitations.push('승인된 proof 의존 관계에 순환 후보가 있습니다. 논증의 참/정합성 판정이 아니며 사용자 확인이 필요합니다.');
      run.outcome = run.issues.length ? 'issues' : 'insufficient';
    }
    if (attempt.graph && run.status === 'complete' && (!state || fingerprint !== attempt.graph.graphFingerprint
      || (await readGraphReviewState(run.documentId, db)).signature !== state.signature)) {
      run.status = 'failed'; run.outcome = 'insufficient';
      run.error = '승인 그래프/채택/정본이 전송 후 변경되었습니다. 검사 결과를 승격하지 않습니다. 제공사 비용은 미확인입니다.';
      run.uncheckedBlockIds = [...run.checkedBlockIds, ...run.uncheckedBlockIds]; run.checkedBlockIds = [];
      run.claims = []; run.issues = []; run.patches = [];
      if (run.external) { run.external.checkedPairIds = []; run.external.assessments = []; }
    }
    if (Date.now() > attempt.deadlineAt && run.status === 'complete') {
      run.status = 'stopped'; run.outcome = 'insufficient'; run.error = '검토 시간 예산을 초과했습니다.';
      run.uncheckedBlockIds = [...run.checkedBlockIds, ...run.uncheckedBlockIds]; run.checkedBlockIds = [];
      run.claims = []; run.issues = []; run.patches = [];
      if (run.external) { run.external.checkedPairIds = []; run.external.assessments = []; }
    }
    attempt.elapsedMs = Math.max(0, Date.now() - attempt.startedAt); attempt.runId = run.id;
    await db.review_runs.add(run); await db.review_campaigns.put(campaign); return campaign;
  });
}

export async function recoverExpiredAttempt(id: string, snapshot: TheorySnapshot, db: QaxiomDatabase = qaxiomDatabase) {
  return db.transaction('rw', [db.review_campaigns, db.review_runs], async () => {
    const campaign = await db.review_campaigns.get(id), attempt = campaign && activeAttempt(campaign);
    if (!campaign?.activeDocumentId || campaign.documentId !== snapshot.document.id || !attempt || Date.now() <= attempt.deadlineAt || attempt.versionId !== snapshot.version.id) throw new Error('진행 중인 검토의 기한이 아직 남아 있거나 해당 원문 버전을 다시 열어야 합니다.');
    const run = reviewSkeleton(snapshot, 'llm-v1', [], attempt.modelId); run.status = 'stopped'; run.outcome = 'insufficient';
    if (attempt.external) { run.checker = 'external-v1'; run.external = { context: attempt.external, checkedPairIds: [], assessments: [] }; }
    if (attempt.graph) run.graph = structuredClone(attempt.graph);
    run.error = '실행 기한이 만료된 검토입니다. 원격 결과와 실제 제공사 비용은 확인하지 못했습니다.';
    // Charge the reserved time rather than inventing execution time while the app was closed.
    attempt.elapsedMs = attempt.deadlineAt - attempt.startedAt; attempt.runId = run.id;
    await db.review_runs.add(run); await db.review_campaigns.put(campaign); return campaign;
  });
}

export function pendingBatches(campaign: ReviewCampaign, runs: ReviewRun[]) {
  const checked = new Set(campaign.attempts.filter(attempt => attempt.versionId === campaign.plan?.versionId)
    .flatMap(attempt => {
      const run = runs.find(run => run.id === attempt.runId && run.status === 'complete');
      if (!run || run.checker === 'external-v1') return [];
      if (!campaign.plan?.graphContexts) return run.checkedBlockIds;
      if (!run.graph || run.graph.graphFingerprint !== campaign.plan.graphContexts[0]?.graphFingerprint) return [];
      return run.checkedBlockIds.filter(id => run.graph!.targetBlockIds.includes(id));
    }));
  return campaign.plan?.batches.map(batch => batch.filter(id => !checked.has(id))).filter(batch => batch.length) ?? [];
}

function requireNote(note: string) {
  if (!note.trim() || note.length > 2000) throw new Error('확인/종료 사유를 1–2,000자로 기록하세요.');
}
export async function confirmCampaignResume(id: string, runId: string, note: string, db: QaxiomDatabase = qaxiomDatabase) {
  requireNote(note);
  return db.transaction('rw', [db.review_campaigns, db.review_runs], async () => {
    const campaign = await db.review_campaigns.get(id);
    if (!campaign?.activeDocumentId || campaign.closure || activeAttempt(campaign)) throw new Error('진행 중이거나 종료된 검토입니다.');
    const stop = campaignStop(campaign, await db.review_runs.where('documentId').equals(campaign.documentId).toArray());
    if (!stop || stop.runId !== runId) throw new Error('중단 사유가 변경되었습니다. 최신 검토를 확인하세요.');
    campaign.confirmations = [...(campaign.confirmations ?? []), { runId, reasons: stop.reasons, note: note.trim(), createdAt: Date.now() }];
    await db.review_campaigns.put(campaign); return campaign;
  });
}
export async function closeCampaign(id: string, snapshot: TheorySnapshot, note: string, db: QaxiomDatabase = qaxiomDatabase) {
  requireNote(note);
  return db.transaction('rw', [db.review_campaigns, db.theory_documents], async () => {
    const campaign = await db.review_campaigns.get(id), document = await db.theory_documents.get(snapshot.document.id);
    if (!campaign || campaign.activeDocumentId !== snapshot.document.id || campaign.closure || activeAttempt(campaign)
      || document?.currentVersionId !== snapshot.version.id) throw new Error('검토 실행/종료 상태 또는 문서 버전이 바뀌었습니다.');
    campaign.closure = { versionId: snapshot.version.id, note: note.trim(), createdAt: Date.now() };
    await db.review_campaigns.put(campaign); return campaign;
  });
}
export async function startNewCampaign(id: string, db: QaxiomDatabase = qaxiomDatabase) {
  return db.transaction('rw', [db.review_campaigns, db.theory_documents], async () => {
    const campaign = await db.review_campaigns.get(id);
    if (!campaign?.activeDocumentId || !campaign.closure || activeAttempt(campaign)) throw new Error('현재 검토를 먼저 종료하세요.');
    campaign.activeDocumentId = null; await db.review_campaigns.put(campaign);
    return ensureCampaign(campaign.documentId, db);
  });
}

/** Validate foreign keys and ledger ownership before replacing any workspace data. */
export function parseCampaigns(value: unknown, theory: TheoryData, runs: ReviewRun[], references: ReferenceData = { references: [], referenceSpans: [] }): ReviewCampaign[] {
  function fail(): never { throw new Error('검토 캠페인의 예산·버전·실행 참조가 올바르지 않습니다.'); }
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
  const number = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const unique = (ids: string[]) => { if (new Set(ids).size !== ids.length) fail(); };
  const blocks = (v: unknown, versionId: string): string[] => {
    if (!Array.isArray(v) || !v.length || !v.every(text)) fail();
    const ids = v as string[]; unique(ids);
    const valid = new Set(theory.documentBlocks.filter(b => b.versionId === versionId).map(b => b.id));
    if (ids.some(id => !valid.has(id))) fail(); return [...ids];
  };
  if (!Array.isArray(value)) fail();
  const campaigns = (value as unknown[]).map(v => {
    if (!record(v) || !text(v.id) || !text(v.documentId) || !number(v.createdAt)
      || (v.activeDocumentId !== null && v.activeDocumentId !== v.documentId)
      || !theory.theoryDocuments.some(d => d.id === v.documentId)
      || !number(v.maxRequests) || v.maxRequests < 1 || v.maxRequests > 100
      || v.maxElapsedMs !== v.maxRequests * 120000 || !Array.isArray(v.attempts) || v.attempts.length > 100) fail();
    const version = (id: unknown): id is string => text(id) && theory.documentVersions.some(d => d.id === id && d.documentId === v.documentId);
    const attempts: ReviewAttempt[] = v.attempts.map(a => {
      if (!record(a) || !text(a.token) || !version(a.versionId) || !text(a.modelId)
        || !number(a.startedAt) || !number(a.deadlineAt) || a.deadlineAt <= a.startedAt || a.deadlineAt - a.startedAt > 120000
        || !number(a.elapsedMs) || (a.runId !== null && !text(a.runId))) fail();
      const blockIds = blocks(a.blockIds, a.versionId);
      const graph = a.graph === undefined ? undefined : parseReviewGraph(a.graph, a.versionId, theory, { reviewRuns: runs });
      const external = a.external === undefined ? undefined : parseExternalContext(a.external, theory, references);
      if (external ? graph || external.versionId !== a.versionId || typeof a.externalStateHash !== 'string' || !/^[a-f0-9]{64}$/.test(a.externalStateHash)
        || blockIds.length !== external.blocks.length || external.blocks.some(b => !blockIds.includes(b.id)) : a.externalStateHash !== undefined) fail();
      if (graph && (blockIds.length !== graph.targetBlockIds.length + graph.premiseBlockIds.length
        || [...graph.targetBlockIds, ...graph.premiseBlockIds].some(id => !blockIds.includes(id)))) fail();
      if (a.runId === null) { if (a.elapsedMs !== 0) fail(); }
      else {
        const run = runs.find(r => r.id === a.runId);
        if (!run || run.documentId !== v.documentId || run.versionId !== a.versionId || run.checker !== (a.external ? 'external-v1' : 'llm-v1')
          || run.modelId !== a.modelId || run.checkedBlockIds.some(id => !blockIds.includes(id))) fail();
        if (JSON.stringify(run.graph) !== JSON.stringify(graph)) fail();
        if (JSON.stringify(run.external?.context) !== JSON.stringify(external)) fail();
      }
      return { token: a.token, versionId: a.versionId, modelId: a.modelId, blockIds,
        startedAt: a.startedAt, deadlineAt: a.deadlineAt, elapsedMs: a.elapsedMs, runId: a.runId,
        ...(external ? { external, externalStateHash: a.externalStateHash as string } : {}),
        ...(graph ? { graph } : {}) } as ReviewAttempt;
    });
    if (attempts.filter(a => a.runId === null).length > 1 || (v.activeDocumentId === null && attempts.some(a => a.runId === null))) fail();
    let plan: ReviewCampaign['plan'] = null;
    if (v.plan !== null) {
      if (!record(v.plan) || !version(v.plan.versionId) || !Array.isArray(v.plan.batches) || !v.plan.batches.length) fail();
      const versionId = v.plan.versionId;
      const batches = v.plan.batches.map(b => blocks(b, versionId)); unique(batches.flat()); plan = { versionId, batches };
      if (v.plan.graphContexts !== undefined) {
        if (!Array.isArray(v.plan.graphContexts) || v.plan.graphContexts.length !== batches.length || batches.length > 100) fail();
        const graphContexts = v.plan.graphContexts.map(g => parseReviewGraph(g, versionId, theory, { reviewRuns: runs }));
        const document = theory.theoryDocuments.find(d => d.id === v.documentId)!;
        const documentVersion = theory.documentVersions.find(d => d.id === versionId)!;
        const snapshot: TheorySnapshot = { document, version: documentVersion, history: theory.documentVersions.filter(d => d.documentId === document.id), blocks: theory.documentBlocks.filter(b => b.versionId === versionId).sort((a, b) => a.position - b.position) };
        graphContexts.forEach((graph, index) => {
          if (JSON.stringify(graph.targetBlockIds) !== JSON.stringify(batches[index]) || graph.graphFingerprint !== graphContexts[0].graphFingerprint) fail();
          prepareReviewRequest(snapshot, snapshot.blocks.filter(b => [...graph.targetBlockIds, ...graph.premiseBlockIds].includes(b.id)).map(b => b.id), graph);
        });
        plan.graphContexts = graphContexts;
      }
    }
    let confirmations: ReviewCampaign['confirmations'];
    if (v.confirmations !== undefined) {
      if (!Array.isArray(v.confirmations) || v.confirmations.length > 500) fail();
      confirmations = v.confirmations.map(c => {
        if (!record(c) || !text(c.runId) || !text(c.note) || c.note.length > 2000 || !number(c.createdAt)
          || !Array.isArray(c.reasons) || !c.reasons.length || !c.reasons.every(r => STOP_REASONS.includes(r as CampaignStopReason))) fail();
        const attempt = attempts.find(a => a.runId === c.runId), run = runs.find(r => r.id === c.runId);
        if (!attempt || !run || c.createdAt < attempt.startedAt) fail();
        const valid = runStopReasons({ ...run, issues: run.issues.map(issue => ({ ...issue, resolvedByRunId: null })) }, attempt.blockIds, runs);
        const reasons = c.reasons as CampaignStopReason[]; unique(reasons);
        if (reasons.some(reason => !valid.includes(reason))) fail();
        return { runId: c.runId, reasons, note: c.note, createdAt: c.createdAt };
      });
      unique(confirmations.flatMap(c => c.reasons.map(reason => `${c.runId}:${reason}`)));
    }
    let closure: ReviewCampaign['closure'];
    if (v.closure !== undefined) {
      if (!record(v.closure) || !version(v.closure.versionId) || !text(v.closure.note) || v.closure.note.length > 2000
        || !number(v.closure.createdAt) || v.closure.createdAt < v.createdAt || attempts.some(a => a.runId === null)) fail();
      closure = { versionId: v.closure.versionId, note: v.closure.note, createdAt: v.closure.createdAt };
    }
    return { id: v.id, documentId: v.documentId, activeDocumentId: v.activeDocumentId, createdAt: v.createdAt,
      maxRequests: v.maxRequests, maxElapsedMs: v.maxElapsedMs, attempts, plan,
      ...(confirmations ? { confirmations } : {}), ...(closure ? { closure } : {}) } as ReviewCampaign;
  });
  unique(campaigns.map(c => c.id)); unique(campaigns.flatMap(c => c.activeDocumentId ? [c.activeDocumentId] : []));
  unique(campaigns.flatMap(c => c.attempts.map(a => a.token)));
  unique(campaigns.flatMap(c => c.attempts.flatMap(a => a.runId ? [a.runId] : [])));
  return campaigns;
}
