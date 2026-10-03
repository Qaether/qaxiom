import { useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { AVAILABLE_MODELS } from '../constants';
import type { UserSettings } from '../types';
import type { TheorySnapshot } from '../services/theory/types';
import type { ReferenceDocument, ReferenceSpan } from '../services/retrieval/types';
import { spanLocation } from '../services/retrieval/pdfTypes';
import { assertExternalCurrent, prepareExternalReview, parseExternalResponse, type ExternalPairInput, type ExternalPreparation } from '../services/theory/externalReview';
import { activeAttempt } from '../services/theory/campaigns';
import { reserveReviewAttempt, finishReviewAttempt, type ReviewCampaign } from '../services/theory/campaigns';
import { reviewSkeleton } from '../services/theory/reviews';
import { sendChatMessage } from '../services/llm';

export default function ExternalReview({ snapshot, settings, modelId, disabled, campaign, onChanged }: {
  snapshot: TheorySnapshot; settings: UserSettings; modelId: string; disabled: boolean; campaign: ReviewCampaign | null; onChanged: () => Promise<void>;
}) {
  const [sources, setSources] = useState<ReferenceDocument[]>([]), [spans, setSpans] = useState<ReferenceSpan[]>([]);
  const [sourceId, setSourceId] = useState(''), [spanId, setSpanId] = useState(''), [blockId, setBlockId] = useState('');
  const [theoryConditions, setTheoryConditions] = useState(''), [referenceConditions, setReferenceConditions] = useState('');
  const [pairs, setPairs] = useState<ExternalPairInput[]>([]);
  const [preview, setPreview] = useState<{ prepared: ExternalPreparation; modelId: string } | null>(null);
  const [busy, setBusy] = useState(false), [running, setRunning] = useState(false), [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const policyKey = useRef('');
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const all = await qaxiomDatabase.references.toArray(), versions = await qaxiomDatabase.document_versions.toArray();
      const project = await qaxiomDatabase.projects.get(snapshot.document.projectId);
      if (active) {
        const key = JSON.stringify([project?.id, project?.sourcePolicy]);
        if (policyKey.current !== key) { policyKey.current = key; setPreview(null); }
        setSources(all.filter(s => (!project?.sourcePolicy || project.sourcePolicy.allowedSourceIds.includes(s.id)) && s.role === 'external' && s.originVersionId === null && !versions.some(v => v.contentHash === s.contentHash)));
      }
    };
    const update = () => void refresh().catch(() => { if (active) setError('외부 원문 목록을 읽지 못했습니다.'); });
    update(); const timer = window.setInterval(update, 2000);
    return () => { active = false; clearInterval(timer); controller.current?.abort(); };
  }, [snapshot.version.id, snapshot.document.projectId]);
  useEffect(() => {
    let active = true;
    void qaxiomDatabase.reference_spans.where('sourceId').equals(sourceId).sortBy('position').then(value => { if (active) setSpans(value); }).catch(() => { if (active) setError('원문 구간을 읽지 못했습니다.'); });
    return () => { active = false; };
  }, [sourceId]);
  const execute = async (task: () => Promise<void>) => { setBusy(true); setError(''); try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : '외부 대조 실패'); } finally { setBusy(false); } };
  const validPreview = preview?.modelId === modelId && preview.prepared.context.versionId === snapshot.version.id ? preview : null;
  const ask = () => execute(async () => {
    if (!validPreview || !campaign) throw new Error('외부 대조 미리보기를 다시 확인하세요.');
    const model = AVAILABLE_MODELS.find(m => m.id === modelId);
    if (!model || model.provider === 'custom' || !settings.apiKeys[model.provider].trim()) throw new Error('선택한 모델의 API 키를 설정하세요. 다른 제공사로 자동 전환하지 않습니다.');
    const prepared = validPreview.prepared;
    const attempt = await reserveReviewAttempt(campaign.id, snapshot, prepared.context.blocks.map(b => b.id), modelId, qaxiomDatabase, undefined, prepared);
    await onChanged();
    const abort = new AbortController(); controller.current = abort; setRunning(true);
    const timeout = window.setTimeout(() => abort.abort(), Math.max(0, attempt.deadlineAt - Date.now()));
    const started = performance.now(); let response = '', failure: Error | null = null;
    const run = reviewSkeleton(snapshot, 'external-v1', [], modelId);
    run.external = { context: prepared.context, checkedPairIds: [], assessments: [] };
    run.limitations = ['독립 원문과 선택 조건의 대조 후보입니다. 이론 내부 논증/참·완전 정합성·독립성 자체를 증명하지 않습니다.'];
    try {
      await assertExternalCurrent(snapshot, prepared);
      await sendChatMessage([{ id: crypto.randomUUID(), role: 'user', content: prepared.request, timestamp: Date.now() }], modelId, 'peer_review', settings, {
        onChunk: chunk => { response += chunk; if (response.length > 100000) { failure = new Error('외부 대조 응답 크기 한도 초과'); abort.abort(); } }, onError: cause => { failure = cause; }, onFinish: () => {}
      }, abort.signal);
      if (failure) throw failure;
      if (abort.signal.aborted) throw new Error('외부 대조가 중단되었거나 시간 예산을 넘었습니다.');
      await assertExternalCurrent(snapshot, prepared);
      const result = parseExternalResponse(response, prepared.context);
      run.external.checkedPairIds = result.checkedPairIds; run.external.assessments = result.assessments; run.limitations.push(...result.limitations);
    } catch (cause) { run.status = abort.signal.aborted ? 'stopped' : 'failed'; run.error = cause instanceof Error ? cause.message : '외부 대조 실패'; }
    finally { window.clearTimeout(timeout); controller.current = null; setRunning(false); run.durationMs = performance.now() - started; }
    try { await finishReviewAttempt(campaign.id, attempt.token, run); setPreview(null); }
    finally { await onChanged(); }
    if (run.error) throw new Error(run.error);
  });
  return <section aria-label="독립 외부 원문 대조">
    <h4>독립 외부 원문 대조 — 내부 논증 검사와 분리</h4>
    <p>레퍼런스 검색에서 등록한 external 자료 중 메모·자체 문서/정본과 같은 hash는 제외합니다. 역할 표시는 학술적 독립성 보증이 아니며 사용자가 출처를 확인해야 합니다. 선택 쌍만 전달하며 대화·PDF 바이트·미선택 자료는 보내지 않습니다.</p>
    {!sources.length && <p>대조 가능한 외부 원문이 없습니다. 레퍼런스 검색에서 검색 가능한 외부 텍스트/PDF를 등록하세요.</p>}
    <fieldset disabled={disabled || busy || !!campaign && !!activeAttempt(campaign)}>
      <legend>대조 쌍 선택 (최대 8개)</legend>
      <label>대조할 이론 블록<select value={blockId} onChange={e => { setBlockId(e.target.value); setPreview(null); }}><option value="">선택</option>{snapshot.blocks.map(b => <option key={b.id} value={b.id}>블록 {b.position + 1} · {b.text.slice(0, 70)}</option>)}</select></label>
      <label>대조할 외부 자료<select value={sourceId} onChange={e => { setSourceId(e.target.value); setSpanId(''); setPreview(null); }}><option value="">선택</option>{sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>대조할 원문 구간<select value={spanId} onChange={e => { setSpanId(e.target.value); setPreview(null); }}><option value="">선택</option>{spans.filter(s => s.sourceId === sourceId).map(s => <option key={s.id} value={s.id}>{spanLocation(s)} · {s.text.slice(0, 70)}</option>)}</select></label>
      <label>대조 이론의 가정·정의·범위<textarea value={theoryConditions} maxLength={2000} onChange={e => { setTheoryConditions(e.target.value); setPreview(null); }} /></label>
      <label>대조 원문의 가정·정의·범위<textarea value={referenceConditions} maxLength={2000} onChange={e => { setReferenceConditions(e.target.value); setPreview(null); }} /></label>
      <button type="button" disabled={!blockId || !spanId || !theoryConditions.trim() || !referenceConditions.trim() || pairs.length >= 8} onClick={() => {
        if (pairs.some(p => p.blockId === blockId && p.spanId === spanId)) { setError('이미 선택한 대조 쌍입니다.'); return; }
        setPairs(previous => [...previous, { blockId, spanId, theoryConditions, referenceConditions }]); setPreview(null);
      }}>외부 대조 쌍 추가</button>
      {pairs.map((p, i) => <p key={p.blockId + p.spanId}>대조 쌍 {i + 1}: {snapshot.blocks.find(b => b.id === p.blockId)?.text.slice(0, 60)} · {p.theoryConditions} / {p.referenceConditions} <button type="button" aria-label={`외부 대조 쌍 ${i + 1} 제거`} onClick={() => { setPairs(old => old.filter((_, index) => index !== i)); setPreview(null); }}>제거</button></p>)}
      <button type="button" disabled={!pairs.length} onClick={() => void execute(async () => { setPreview(null); setPreview({ prepared: await prepareExternalReview(snapshot, pairs), modelId }); })}>외부 대조 전송 미리보기</button>
    </fieldset>
    {validPreview && <section aria-label="외부 대조 전송 미리보기">
      <p>모델 {modelId} · 전체 연구 기준과 선택 쌍 {validPreview.prepared.context.pairs.length}개. 이론 미선택 {validPreview.prepared.context.omittedBlockCount}블록. 원문 지시는 신뢰하지 않는 데이터이며 프롬프트 주입 방지를 보증하지 않습니다.</p>
      {validPreview.prepared.context.evidence.map(e => <p key={e.citationId}>{e.citationId} · {e.name} · {spanLocation(e.span)} · {e.pdf && `PDF 원본 대조 필요: 수식/다단 순서 미보증 · 텍스트 없음/검색 제외 페이지 ${e.pdf.emptyPages.join(', ') || '없음'}`}</p>)}
      {validPreview.prepared.context.omissions.map(o => <p key={o.sourceId}>외부 미선택 원문 {o.omittedSpanCount}구간 · 누락 위치 {JSON.stringify(o.ranges)}</p>)}
      <pre>{validPreview.prepared.request}</pre>
      <button type="button" disabled={disabled || busy || !campaign || !!campaign && !!activeAttempt(campaign)} onClick={() => void ask()}>이 범위로 외부 대조 실행</button>
    </section>}
    {running && <button type="button" onClick={() => controller.current?.abort()}>외부 대조 중단</button>}
    {busy && <p role="status">외부 대조 작업 중…</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
