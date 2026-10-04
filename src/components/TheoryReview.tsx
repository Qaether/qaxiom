import { useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { sendChatMessage } from '../services/llm';
import type { UserSettings } from '../types';
import type { TheorySnapshot } from '../services/theory/types';
import type { ReviewRun } from '../services/theory/reviewTypes';
import { checkerCovers, isLocalChecker } from '../services/theory/reviewTypes';
import { applyTheoryPatch, parseModelReview, prepareReviewRequest, reviewSkeleton, runLocalReview, setClaimAcceptance, resolveReviewIssue } from '../services/theory/reviews';
import { activeAttempt, changeCampaignBudget, closeCampaign, confirmCampaignResume, ensureCampaign, finishReviewAttempt, getCampaign, recoverExpiredAttempt, reserveReviewAttempt, spentTime, startNewCampaign, type ReviewCampaign } from '../services/theory/campaigns';
import { campaignStop, STOP_LABELS } from '../services/theory/campaignPolicy';
import { reviewToMarkdown } from '../services/theory/reviewReport';
import { assertGraphReviewCurrent, prepareGraphReview, type GraphReviewPreparation } from '../services/theory/reviewGraph';
import PatchImpact from './PatchImpact';
import ExternalRelationApproval from './ExternalRelationApproval';
import ExternalReview from './ExternalReview';
import ReferenceSource from './ReferenceSource';
import type { ContextEvidence } from '../services/retrieval/types';

const outcomeLabels = { issues: '확인할 항목 있음', scope_passed: '확인한 범위에서 구조 문제 없음', insufficient: '판단 자료 부족' };
const statusLabels: Record<ReviewRun['status'], string> = { complete: '검사 완료', stopped: '검사 중단', failed: '검사 실패' };
const issueKindLabels: Record<ReviewRun['issues'][number]['kind'], string> = {
  missing_contract: '연구 기준 미작성',
  broken_reference: '연결할 문단을 찾을 수 없음',
  argument: '논리 전개 확인 필요',
  scope: '적용 범위 확인 필요',
  counterexample: '반례 후보',
  insufficient_evidence: '판단 근거 부족',
  invalid_declaration: '기호·의존성 선언 형식 확인 필요',
  symbol_conflict: '기호 정의 충돌',
  undefined_symbol: '정의하지 않은 기호',
  proof_cycle: '증명 의존 순환 후보'
};
const severityLabels: Record<ReviewRun['issues'][number]['severity'], string> = { info: '참고', warning: '주의', critical: '중요' };
const claimKindLabels: Record<ReviewRun['claims'][number]['kind'], string> = {
  assumption: '가정', definition: '정의', conjecture: '가설', lemma: '보조정리', theorem: '정리', result: '주장·결과'
};
const blockKindLabels: Record<TheorySnapshot['blocks'][number]['kind'], string> = {
  heading: '제목', paragraph: '본문', code: '코드', math: '수식'
};
const contractLabels: Record<keyof TheorySnapshot['version']['contract'], string> = {
  purpose: '연구 목적', assumptions: '가정·공리', definitions: '핵심 정의', symbols: '기호표', scope: '적용 범위', openQuestions: '미해결 문제'
};

export default function TheoryReview({ snapshot, settings, modelId, dirty, onSaved }: {
  snapshot: TheorySnapshot; settings: UserSettings; modelId: string; dirty: boolean; onSaved: (snapshot: TheorySnapshot) => void;
}) {
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [selected, setSelected] = useState<string[]>(snapshot.blocks.map(block => block.id));
  const [preview, setPreview] = useState('');
  const [previewVersion, setPreviewVersion] = useState('');
  const [previewModel, setPreviewModel] = useState('');
  const [includeGraph, setIncludeGraph] = useState(false);
  const [graphPreview, setGraphPreview] = useState<GraphReviewPreparation | null>(null);
  const [externalOriginal, setExternalOriginal] = useState<ContextEvidence | null>(null);
  const [modelRunning, setModelRunning] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [campaign, setCampaign] = useState<ReviewCampaign | null>(null);
  const [campaignHistory, setCampaignHistory] = useState<ReviewCampaign[]>([]);
  const [decisionNote, setDecisionNote] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const requestBudget = campaign?.maxRequests ?? 3;
  const usedRequests = campaign?.attempts.length ?? 0;
  const runningAttempt = campaign && activeAttempt(campaign);
  const stop = campaign ? campaignStop(campaign, runs) : null;
  const selectedCurrent = selected.filter(id => snapshot.blocks.some(block => block.id === id));
  const previewBlockIds = graphPreview?.blockIds ?? selectedCurrent;
  const previewBlocks = snapshot.blocks.filter(block => previewBlockIds.includes(block.id));
  const omittedBlocks = snapshot.blocks.filter(block => !previewBlockIds.includes(block.id));
  const previewDocument = previewBlocks.length === snapshot.blocks.length
    ? snapshot.version.markdown : previewBlocks.map(block => block.text).join('\n');
  const filledContract = (Object.keys(contractLabels) as (keyof typeof contractLabels)[])
    .filter(key => snapshot.version.contract[key].trim());
  const controller = useRef<AbortController | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (preview && previewVersion === snapshot.version.id && previewModel === modelId) {
      previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [preview, previewVersion, previewModel, snapshot.version.id, modelId]);
  const refresh = async () => {
    setRuns(await qaxiomDatabase.review_runs.where('documentId').equals(snapshot.document.id).reverse().sortBy('createdAt'));
    setCampaign(await ensureCampaign(snapshot.document.id));
    setCampaignHistory(await qaxiomDatabase.review_campaigns.where('documentId').equals(snapshot.document.id).toArray());
  };
  useEffect(() => {
    let active = true;
    void qaxiomDatabase.review_runs.where('documentId').equals(snapshot.document.id).reverse().sortBy('createdAt')
      .then(runs => { if (active) setRuns(runs); }).catch(() => { if (active) setError('검토 기록을 읽지 못했습니다.'); });
    void ensureCampaign(snapshot.document.id).then(value => { if (active) setCampaign(value); })
      .catch(() => { if (active) setError('검토 예산을 읽지 못했습니다.'); });
    void qaxiomDatabase.review_campaigns.where('documentId').equals(snapshot.document.id).toArray()
      .then(value => { if (active) setCampaignHistory(value); }).catch(() => {});
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void getCampaign(snapshot.document.id).then(async value => {
        if (active && value) setCampaign(value);
        const updated = await qaxiomDatabase.review_runs.where('documentId').equals(snapshot.document.id).reverse().sortBy('createdAt');
        if (active) setRuns(updated);
      }).catch(() => {});
    }, 2000);
    return () => { active = false; window.clearInterval(timer); controller.current?.abort(); };
  }, [snapshot.document.id]);
  const execute = async (task: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : '검토 작업 실패'); }
    finally { setBusy(false); }
  };
  const askModel = () => execute(async () => {
    const prepared = includeGraph ? graphPreview : null;
    const blockIds = prepared?.blockIds ?? selectedCurrent;
    if (!campaign || !preview || previewModel !== modelId || previewVersion !== snapshot.version.id
      || (includeGraph && (!prepared || selectedCurrent.length !== prepared.graph.targetBlockIds.length || selectedCurrent.some(id => !prepared.graph.targetBlockIds.includes(id))))
      || preview !== prepareReviewRequest(snapshot, blockIds, prepared?.graph)) throw new Error('전송 범위 또는 회차 예산을 다시 확인하세요.');
    const attempt = await reserveReviewAttempt(campaign.id, snapshot, blockIds, modelId, qaxiomDatabase, prepared ?? undefined);
    await refresh();
    const abort = new AbortController(); controller.current = abort;
    setModelRunning(true);
    const started = performance.now(); let text = '', failure: Error | null = null;
    const timeout = window.setTimeout(() => abort.abort(), Math.max(0, attempt.deadlineAt - Date.now()));
    let run: ReviewRun;
    try {
      await sendChatMessage([{ id: crypto.randomUUID(), role: 'user', content: preview, timestamp: Date.now() }], modelId, 'peer_review', settings, {
        onChunk: chunk => { text += chunk; if (text.length > 100000) { failure = new Error('검토 응답 크기 한도 초과'); abort.abort(); } },
        onError: error => { failure = error; }, onFinish: () => {}
      }, abort.signal);
      if (failure) throw failure;
      if (abort.signal.aborted) throw new Error('검토가 중단되었거나 120초 시간 예산을 넘었습니다.');
      if (prepared) await assertGraphReviewCurrent(snapshot, prepared);
      run = parseModelReview(text, snapshot, blockIds, modelId);
      if (prepared?.graph.proofCycleRelationIds.length) {
        run.limitations.push('승인된 proof 의존 관계에 순환 후보가 있습니다. 논증의 참/정합성 판정이 아니며 사용자 확인이 필요합니다.');
        run.outcome = run.issues.length ? 'issues' : 'insufficient';
      }
      run.durationMs = performance.now() - started;
    } catch (cause) {
      run = reviewSkeleton(snapshot, 'llm-v1', [], modelId);
      run.status = abort.signal.aborted ? 'stopped' : 'failed'; run.outcome = 'insufficient';
      run.durationMs = performance.now() - started; run.error = cause instanceof Error ? cause.message : '검토 실패';
    } finally { window.clearTimeout(timeout); controller.current = null; setModelRunning(false); }
    try { await finishReviewAttempt(campaign.id, attempt.token, run); setPreview(''); }
    finally { await refresh(); }
    if (run.error) throw new Error(run.error);
  });
  const prepareSimpleReview = () => execute(async () => {
    const allBlocks = snapshot.blocks.map(block => block.id);
    const request = prepareReviewRequest(snapshot, allBlocks);
    setSelected(allBlocks); setIncludeGraph(false); setGraphPreview(null);
    setPreviewVersion(snapshot.version.id); setPreviewModel(modelId); setPreview(request);
  });
  const latest = runs[0];
  return <section aria-label="문서 검토" className="theory-review">
    <div className="theory-review-intro">
      <div>
        <p className="theory-review-eyebrow">현재 문서 · v{snapshot.version.number}</p>
        <h4>{snapshot.version.title}</h4>
        <p>AI가 문서의 주장과 논리상 확인할 지점을 제안합니다. 결과는 검토를 돕는 의견이며 정합성이나 참을 보증하지 않습니다.</p>
      </div>
      <p className="theory-review-model">모델 <strong>{modelId}</strong></p>
    </div>
    {dirty && <p className="theory-review-warning" role="status">저장하지 않은 수정이 있습니다. 새 버전으로 저장한 뒤 분석하세요.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="theory-review-primary">
      <div><strong>연구 문서 전체 분석</strong><p>저장한 문서와 연구 기준을 한 번에 확인합니다. 대화·레퍼런스·PDF 원본은 보내지 않습니다.</p></div>
      <button type="button" disabled={busy || dirty || !campaign || !!runningAttempt || !!campaign.closure || !!stop || usedRequests >= requestBudget || !snapshot.blocks.length}
        onClick={() => void prepareSimpleReview()}>전송 내용 확인</button>
    </div>
    <p className="theory-review-progress">이번 검토 {usedRequests}/{requestBudget}회 사용{usedRequests > 0 && ' · 요청마다 모델 비용 발생'}</p>
    {(stop || campaign?.closure || usedRequests >= requestBudget) && <p className="theory-review-warning">추가 분석을 위해 아래 ‘검토 회차 관리’에서 중단 사유나 요청 한도를 확인하세요.</p>}
    <details className="theory-review-advanced"><summary>부분 분석·추가 문맥 (선택)</summary>
      <p>특정 부분만 다시 확인하거나 승인된 전제 관계를 함께 보내려는 경우에 사용하세요. 기본 분석은 저장 문서 전체를 한 번에 보냅니다.</p>
      {runningAttempt && !modelRunning && <p>다른 탭 또는 중단된 실행의 기한: {new Date(runningAttempt.deadlineAt).toLocaleTimeString()}. 자동 재전송하지 않습니다.</p>}
      {runningAttempt && !modelRunning && <button type="button" disabled={busy || now <= runningAttempt.deadlineAt} onClick={() => void execute(async () => {
        const version = await qaxiomDatabase.document_versions.get(runningAttempt.versionId);
        if (!version || !campaign) throw new Error('검토 원문 버전이 없습니다.');
        const blocks = await qaxiomDatabase.document_blocks.where('versionId').equals(version.id).sortBy('position');
        await recoverExpiredAttempt(campaign.id, { document: snapshot.document, version, blocks, history: snapshot.history }); await refresh();
      })}>만료된 실행 종료 · 재개 준비</button>}
      <fieldset disabled={busy || dirty || !campaign || !!runningAttempt || !!campaign.closure}>
      <legend>전송할 문단과 추가 문맥</legend>
      <p>선택한 문단과 연구 기준 전체만 보냅니다. 미선택 문단은 미검사로 남습니다.</p>
      <label><input type="checkbox" checked={includeGraph} onChange={event => { setIncludeGraph(event.target.checked); setPreview(''); setGraphPreview(null); }} />승인 관계의 전제·정의도 포함</label>
      {includeGraph && <p>선택한 문단에 연결된 승인 전제를 추가합니다. 추가 문맥도 전송 범위에 표시하며 외부 레퍼런스는 포함하지 않습니다.</p>}
      <label>최대 검토 요청 횟수<input aria-label="최대 검토 요청 횟수" type="number" min={1} max={100} value={requestBudget} onChange={event => {
        const value = Number(event.target.value); setPreview('');
        if (campaign) void execute(async () => { setCampaign(await changeCampaignBudget(campaign.id, value)); });
      }} /></label>
      <p>사용 {usedRequests}/{requestBudget}회 · 요청별 최대 120초 · 저장된 사용 시간 {Math.ceil((campaign ? spentTime(campaign) : 0) / 1000)}/{requestBudget * 120}초. 실패도 회차를 사용합니다. 토큰 비용 추정은 제공하지 않습니다.</p>
      <div className="theory-review-block-list">{snapshot.blocks.map(block => <label className="reference-choice" key={block.id}>
        <input type="checkbox" checked={selected.includes(block.id)} onChange={event => {
          setPreview(''); setGraphPreview(null); setSelected(previous => event.target.checked ? [...previous, block.id] : previous.filter(id => id !== block.id));
        }} /><span>문단 {block.position + 1} · {blockKindLabels[block.kind]} · {block.text.slice(0, 100)}</span>
      </label>)}</div>
      <button type="button" disabled={!selectedCurrent.length || usedRequests >= requestBudget || !!stop} onClick={() => void execute(async () => {
        setPreview(''); setGraphPreview(null);
        const prepared = includeGraph ? await prepareGraphReview(snapshot, selectedCurrent) : null;
        setGraphPreview(prepared); setPreviewVersion(snapshot.version.id); setPreviewModel(modelId);
        setPreview(prepared?.request ?? prepareReviewRequest(snapshot, selectedCurrent));
      })}>검토 전송 미리보기</button>
      </fieldset>
    </details>
    {(usedRequests > 0 || !!stop || !!campaign?.closure || campaignHistory.some(item => item.id !== campaign?.id)) && <details className="theory-review-advanced"><summary>검토 회차 관리</summary>
    {stop && !campaign?.closure && <section aria-label="검토 중단 사유">
      <h4>추가 요청 전 확인 필요</h4>
      {stop.reasons.map(reason => <p key={reason}>{STOP_LABELS[reason]}</p>)}
      <p>반복/재발은 같은 종류·블록 ID·정규화한 원문 인용의 일치 후보입니다. 의미적 동일성이나 실제 재발을 확정하지 않습니다. 확인은 Issue 해결 표시가 아닙니다.</p>
      <label>재개 또는 종료 사유<textarea value={decisionNote} maxLength={2000} onChange={event => setDecisionNote(event.target.value)} /></label>
      <button type="button" disabled={busy || !!runningAttempt || !decisionNote.trim()} onClick={() => void execute(async () => {
        if (campaign) await confirmCampaignResume(campaign.id, stop.runId, decisionNote);
        setDecisionNote(''); setPreview(''); await refresh();
      })}>중단 사유 확인 · 수동 재개 허용</button>
    </section>}
    {campaign?.closure ? <section aria-label="종료된 검토">
      <p>이번 검토 종료 · 버전 {campaign.closure.versionId} · {campaign.closure.note}. 종료는 사용자 판단이며 정합성 통과가 아닙니다.</p>
      <button type="button" disabled={busy || dirty} onClick={() => {
        if (!window.confirm('이전 사용 기록을 보존하고 새 검토 예산(3회)을 시작할까요? 자동 전송은 하지 않습니다.')) return;
        void execute(async () => { await startNewCampaign(campaign.id); setPreview(''); setDecisionNote(''); await refresh(); });
      }}>새 검토 시작 · 이전 기록 보존</button>
    </section> : campaign && <section aria-label="검토 종료">
      {!stop && <label>재개 또는 종료 사유<textarea value={decisionNote} maxLength={2000} onChange={event => setDecisionNote(event.target.value)} /></label>}
      <p>검사 범위·미검사·미해결 Issue를 확인한 뒤 종료 사유를 기록하세요. 미해결 상태로 종료할 수 있으며 통과 판정으로 바뀌지 않습니다.</p>
      <button type="button" disabled={busy || dirty || !!runningAttempt || !decisionNote.trim()} onClick={() => void execute(async () => {
        await closeCampaign(campaign.id, snapshot, decisionNote); setDecisionNote(''); setPreview(''); await refresh();
      })}>이번 검토 종료 · 판정은 유지</button>
    </section>}
    {!!campaignHistory.filter(item => item.id !== campaign?.id).length && <details><summary>이전 검토 회차 기록</summary>
      {campaignHistory.filter(item => item.id !== campaign?.id).map(item => <p key={item.id}>검토 {item.id} · 사용 {item.attempts.length}/{item.maxRequests}회 · {item.closure?.note ?? '과거 기록'}</p>)}
    </details>}
    {!!campaign?.confirmations?.length && <details><summary>중단 사유 확인 기록</summary>
      {campaign.confirmations.map((item, index) => <div key={index}>
        <p>검토 {item.runId} · {new Date(item.createdAt).toLocaleString()} · {item.reasons.map(reason => STOP_LABELS[reason]).join(', ')}</p>
        <p>{item.note} · Issue 해결/정합성 통과 표시가 아님</p>
      </div>)}
    </details>}
    </details>}
    <details className="theory-review-advanced theory-review-local"><summary>로컬 구조 확인 · 인터넷 전송 없음</summary>
      <p>연구 기준의 빈 항목, 문단 연결과 기호 선언 형식만 확인합니다. 글의 의미나 이론의 옳고 그름은 판단하지 않습니다.</p>
      <button type="button" disabled={busy || dirty} onClick={() => void execute(async () => { await runLocalReview(snapshot); await refresh(); })}>기본 구조 확인</button>
    </details>
    {preview && previewVersion === snapshot.version.id && previewModel === modelId && <section ref={previewRef} className="theory-review-preview" aria-label="검토 전송 미리보기">
      <p className="theory-review-eyebrow">전송 전 확인 · 아직 모델에 보내지 않았습니다</p>
      <h4>AI에 보낼 내용</h4>
      {includeGraph && graphPreview && <p>목표 {graphPreview.graph.targetBlockIds.length}블록 · 추가 전제 {graphPreview.graph.premiseBlockIds.length}블록 · 승인 관계 {graphPreview.graph.relationSnapshots.length}개 · 외부 자료 미전송 {graphPreview.graph.excludedCounts.external_not_selected}개. 추가 문맥의 첨부가 실제 검사를 의미하지는 않습니다.</p>}
      <p>선택 모델: {modelId} · {omittedBlocks.length ? `선택 문단 ${previewBlocks.length}/${snapshot.blocks.length}개` : '문서 전체'} · 작성한 연구 기준 {filledContract.length}/6개 · 요청 크기 약 {Math.ceil(new TextEncoder().encode(preview).byteLength / 1024)} KB</p>
      {!!filledContract.length && <details open><summary>함께 보내는 연구 기준 {filledContract.length}개</summary>
        {filledContract.map(key => <div key={key}><strong>{contractLabels[key]}</strong><p>{snapshot.version.contract[key]}</p></div>)}
      </details>}
      <div className="theory-review-preview-blocks">
        <strong>함께 보내는 문서 원문</strong>
        <pre className="theory-review-document">{previewDocument}</pre>
      </div>
      {!!omittedBlocks.length && <details><summary>보내지 않는 문단 {omittedBlocks.length}개</summary>
        <p>{omittedBlocks.map(block => block.position + 1).join(', ')}번 문단은 이번 요청에 포함되지 않아 검사 결과에도 포함되지 않습니다.</p>
      </details>}
      <p>이번 요청에서 제외: 기존 대화, 레퍼런스, PDF 원본. 앱에서 요청 본문을 자동 분할·생략하지 않습니다. 제공사 모델의 실제 한도는 다를 수 있습니다.</p>
      <details className="theory-review-technical"><summary>전송 요청의 기술 정보</summary>
        <p>문서 안의 지시는 검토 대상 데이터로 전달합니다. 아래 내용에는 버전·hash·누락 ID와 모델 출력 형식이 포함됩니다.</p><pre>{preview}</pre>
      </details>
      <p>실행하면 선택한 모델에 요청하며 비용이 발생할 수 있습니다.</p>
      <button type="button" className="theory-review-send" disabled={busy || dirty || usedRequests >= requestBudget || !!stop || !!campaign?.closure || !!runningAttempt} onClick={() => void askModel()}>이 범위로 LLM 검토 실행</button>
    </section>}
    {busy && <p role="status">검토 작업 중…</p>}
    {modelRunning && busy && <button type="button" onClick={() => controller.current?.abort()}>검토 중단</button>}
    <details className="theory-external-advanced"><summary>외부 문헌과 대조 (선택)</summary>
      <ExternalReview snapshot={snapshot} settings={settings} modelId={modelId} campaign={campaign} disabled={busy || dirty || !!stop || !!campaign?.closure || usedRequests >= requestBudget} onChanged={refresh} />
    </details>
    <div className="theory-review-results-heading"><h4>검토 결과</h4><p>저장된 분석과 로컬 검사를 최신순으로 표시합니다. 제안은 문서 수정·재검사의 출발점입니다.</p></div>
    {!runs.length && <p className="theory-review-empty">아직 검사 결과가 없습니다.</p>}
    {latest && latest.versionId !== snapshot.version.id && <p>이전 검토는 오래된 버전의 결과입니다. 현재 버전을 재검사하세요.</p>}
    {runs.map(run => {
      const version = snapshot.history.find(item => item.id === run.versionId);
      const current = run.versionId === snapshot.version.id;
      const missingCriteria = run.issues.filter(issue => issue.kind === 'missing_contract');
      const otherIssues = run.issues.filter(issue => issue.kind !== 'missing_contract');
      const emptyCriteria = current
        ? (Object.keys(contractLabels) as (keyof typeof contractLabels)[]).filter(key => !snapshot.version.contract[key].trim()).map(key => contractLabels[key])
        : [];
      const reviewName = isLocalChecker(run.checker) ? '기본 구조 확인'
        : run.checker === 'external-v1' ? `AI 외부 원문 대조 · ${run.modelId}` : `AI 내용·논리 검토 · ${run.modelId}`;
      return <article key={run.id} aria-label={`검토 결과 ${run.id}`} className="theory-review-result">
      <h4>{reviewName}</h4>
      <p className="theory-review-summary"><strong>{statusLabels[run.status]}</strong> · {outcomeLabels[run.outcome]} · {version ? `v${version.number}` : '저장된 과거 버전'}</p>
      <button type="button" disabled={busy} onClick={() => void execute(async () => {
        const version = await qaxiomDatabase.document_versions.get(run.versionId);
        if (!version) throw new Error('검토 원문 버전이 없습니다.');
        const blocks = await qaxiomDatabase.document_blocks.where('versionId').equals(version.id).sortBy('position');
        const url = URL.createObjectURL(new Blob([reviewToMarkdown(run, version, blocks)], { type: 'text/markdown;charset=utf-8' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = `qaxiom-review-${run.id}.md`; anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      })}>검토 보고서 내보내기</button>
      <p>문단 {run.checkedBlockIds.length}/{run.checkedBlockIds.length + run.uncheckedBlockIds.length}개 확인 · 확인하지 않은 문단 {run.uncheckedBlockIds.length}개 {!current && '· 이전 버전의 결과'}</p>
      {run.external && <section aria-label="외부 대조 결과"><p>외부 쌍 실제 대조 {run.external.checkedPairIds.length}/{run.external.context.pairs.length}. 내부 논증 검사 수에는 합산하지 않습니다. 분류는 모델 제안이며 관계 승인·증명이 아닙니다.</p>
        {run.external.assessments.map(a => {
          const pair = run.external!.context.pairs.find(p => p.id === a.pairId), evidence = run.external!.context.evidence.find(e => e.citationId === pair?.citationId);
          return <div key={a.pairId}><p>{a.label} · {a.explanation}</p><p>이론 조건: {a.theoryConditions} / 원문 조건: {a.referenceConditions}</p><pre>{a.theoryQuote}</pre><pre>{a.referenceQuote}</pre>
            {evidence && <button type="button" onClick={() => setExternalOriginal(evidence)}>대조 원문 확인: {evidence.name}</button>}
            <ExternalRelationApproval run={run} pairId={a.pairId} snapshot={snapshot} runs={runs} disabled={busy || dirty || !!runningAttempt} onChanged={refresh} /></div>;
        })}
        <p>전송 당시의 원문·조건·누락 범위는 내보낸 검토 보고서에 보존됩니다.</p></section>}
      {run.graph && <p>승인 관계를 포함해 목표 {run.graph.targetBlockIds.length}개 문단과 추가 전제 {run.graph.premiseBlockIds.length}개 문단을 전송했습니다. 추가 전제는 검사 완료 수에 포함하지 않습니다.</p>}
      {run.error && <p>{run.error}</p>}
      {!!run.limitations.length && <details className="theory-review-limitations"><summary>이 검사로 확인하지 않은 것</summary>
        {run.limitations.map((limitation, index) => <p key={index}>{limitation}</p>)}</details>}
      {!!missingCriteria.length && <section className="theory-review-notice" aria-label="작성하지 않은 연구 기준">
        <strong>연구 기준 {missingCriteria.length}개가 비어 있습니다.</strong>
        <p>미작성 항목: {emptyCriteria.length ? emptyCriteria.join(', ') : '검토 당시 일부 연구 기준'}. 이 항목들은 선택 사항이며, AI 검토에서 적용 범위를 더 분명히 하고 싶을 때 채우면 됩니다.</p>
      </section>}
      <details open={run.checker === 'llm-v1'}><summary>문서에서 찾은 주장 후보 {run.claims.length}개</summary>
        <p>제목과 문단 표현을 기준으로 자동 분류한 후보입니다. 내용을 이해하거나 참이라고 판정한 결과가 아닙니다.</p>
        {run.claims.map(claim => {
          const block = current ? snapshot.blocks.find(item => item.id === claim.blockId) : null;
          return <div key={claim.id}><p>{claimKindLabels[claim.kind]} · {claim.origin === 'model' ? 'AI가 제안' : '문서 구조에서 추정'}{block ? ` · 문단 ${block.position + 1}` : ''}</p><pre>{claim.statement}</pre>
          <select aria-label={`주장 채택 상태 ${claim.id}`} value={claim.acceptance} disabled={busy} onChange={event => void execute(async () => {
            await setClaimAcceptance(run.id, claim.id, event.target.value as typeof claim.acceptance); await refresh();
          })}><option value="proposed">제안</option><option value="accepted">채택</option><option value="rejected">기각</option></select>
        </div>; })}
      </details>
      {otherIssues.map(issue => <div className="theory-change theory-review-issue" key={issue.id}><strong>{severityLabels[issue.severity]} · {issueKindLabels[issue.kind]}</strong>
        <p>{issue.resolvedByRunId ? `재검사 후 사용자 해결 표시 · ${issue.resolvedByRunId}` : '미해결'}</p>
        <p>{issue.explanation}</p><p>해결 조건: {issue.resolution}</p>
        {!issue.resolvedByRunId && run.versionId !== snapshot.version.id && runs.some(recheck => recheck.versionId === snapshot.version.id && checkerCovers(run.checker, recheck.checker) && recheck.outcome === 'scope_passed' && !recheck.uncheckedBlockIds.length) &&
          <button type="button" disabled={busy || dirty} onClick={() => {
            if (!window.confirm('후속 버전의 전체 범위 재검사 결과와 해결 조건을 확인했습니까? 이 표시는 사용자의 해결 판단이며 이론의 참을 보증하지 않습니다.')) return;
            const recheck = runs.find(recheck => recheck.versionId === snapshot.version.id && checkerCovers(run.checker, recheck.checker) && recheck.outcome === 'scope_passed' && !recheck.uncheckedBlockIds.length)!;
            void execute(async () => { await resolveReviewIssue(run.id, issue.id, recheck.id); await refresh(); });
          }}>재검사 결과 확인 · Issue 해결 표시</button>}
        {issue.quotes.map((quote, index) => {
          const block = current ? snapshot.blocks.find(item => item.id === issue.blockIds[index]) : null;
          return <pre key={index}>{block ? `문단 ${block.position + 1}: ` : ''}{quote}</pre>;
        })}
        {run.patches.filter(patch => patch.issueIds.includes(issue.id)).map(patch => <div key={patch.id}>
          <p>새 가정: {patch.introducedAssumptions || '선언 없음 (숨은 새 가정이 없는지는 사용자 확인 필요)'}</p>
          <details><summary>수정 제안의 기술 정보</summary><p>변경 전 원문 hash: {patch.beforeHash}</p></details>
          <div className="theory-diff"><pre>{snapshot.version.id === run.versionId ? snapshot.blocks.find(block => block.id === patch.blockId)?.text : '이전 버전의 원문'}</pre><pre>{patch.replacement}</pre></div>
          <PatchImpact run={run} patch={patch} snapshot={snapshot} runs={runs} disabled={busy || dirty} onApply={impact => {
            void execute(async () => { const saved = await applyTheoryPatch(run.id, patch.id, qaxiomDatabase, impact); setPreview(''); setGraphPreview(null); setSelected(saved.blocks.map(block => block.id)); onSaved(saved); await refresh(); });
          }} onSelect={blockIds => { setSelected(blockIds); setPreview(''); setGraphPreview(null); setIncludeGraph(false); }} />
        </div>)}
      </div>)}
    </article>; })}
    {externalOriginal && <ReferenceSource evidence={externalOriginal} onClose={() => setExternalOriginal(null)} />}
  </section>;
}
