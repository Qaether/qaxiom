import { useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { createEmbeddingSpace, indexEmbeddingPlan, prepareEmbeddingPlan, requestEmbeddings, embeddingBody, type EmbeddingPlan } from '../services/retrieval/embeddings';
import type { EmbeddingSpace, EmbeddingVector, EmbeddingActivation, HybridTrace } from '../services/retrieval/embeddingTypes';
import { activateGeneration, prepareGenerationActivation, loadActiveGeneration, assertActiveGeneration } from '../services/retrieval/embeddingGenerations';
import type { ReferenceData, RetrievalHit } from '../services/retrieval/types';
import { spanLocation } from '../services/retrieval/pdfTypes';
import { assertEmbeddingScopeCurrent, captureEmbeddingScope, type EmbeddingProjectScope } from '../services/retrieval/embeddingScope';

export default function SemanticRetrieval({ selected, query, researchVersionId, projectId, apiKey, busy, onBusy, onResults }: {
  selected: string[]; query: string; apiKey: string; busy: boolean; onBusy: (busy: boolean) => void;
  researchVersionId: string;
  projectId: string;
  onResults: (hits: RetrievalHit[], data: ReferenceData, trace: HybridTrace) => void;
}) {
  const [space, setSpace] = useState<EmbeddingSpace | null>(null);
  const [spaces, setSpaces] = useState<EmbeddingSpace[]>([]);
  const [sealedIds, setSealedIds] = useState<string[]>([]);
  const [activeGeneration, setActiveGeneration] = useState<EmbeddingActivation | null>(null);
  const [savedActivation, setActivation] = useState<(Awaited<ReturnType<typeof prepareGenerationActivation>> & { scopeKey: string; projectScope: EmbeddingProjectScope | null }) | null>(null);
  const [savedPlan, setPlan] = useState<(EmbeddingPlan & { scopeKey: string }) | null>(null);
  const [savedQueryPreview, setQueryPreview] = useState<{ scopeKey: string; query: string; data: ReferenceData; vectors: EmbeddingVector[]; space: EmbeddingSpace; activation: EmbeddingActivation; projectScope: EmbeddingProjectScope | null } | null>(null);
  const [maxRequests, setMaxRequests] = useState(3);
  const [error, setError] = useState(''); const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null), worker = useRef<Worker | null>(null);
  const scopeKey = JSON.stringify([selected, query, maxRequests, researchVersionId, projectId]);
  const plan = savedPlan?.scopeKey === scopeKey && savedPlan.space.id === space?.id ? savedPlan : null;
  const activationPreview = savedActivation?.scopeKey === scopeKey && savedActivation.manifest.spaceId === space?.id ? savedActivation : null;
  const queryPreview = savedQueryPreview?.scopeKey === scopeKey && savedQueryPreview.activation.revision === activeGeneration?.revision ? savedQueryPreview : null;
  const refresh = async () => {
    const [all, manifests, active] = await Promise.all([qaxiomDatabase.embedding_spaces.orderBy('createdAt').reverse().toArray(),
      qaxiomDatabase.embedding_manifests.toArray(), qaxiomDatabase.embedding_activations.get('active')]);
    return { all, manifests, active };
  };
  const update = (value: Awaited<ReturnType<typeof refresh>>) => {
    setSpaces(value.all); setSealedIds(value.manifests.map(m => m.spaceId)); setActiveGeneration(value.active ?? null);
    setSpace(previous => previous ?? value.all[0] ?? null);
  };
  useEffect(() => {
    let active = true;
    const poll = () => void refresh().then(value => { if (active) update(value); }).catch(() => { if (active) setError('의미 색인 목록을 읽지 못했습니다.'); });
    poll(); const timer = window.setInterval(poll, 2000);
    return () => { active = false; window.clearInterval(timer); abort.current?.abort(); worker.current?.terminate(); };
  }, []);
  const execute = async (task: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController(); abort.current = controller; onBusy(true); setRunning(true); setError('');
    try { await task(controller.signal); }
    catch (cause) { setError(controller.signal.aborted ? '중단했습니다. 완료·저장된 구간은 보존하며 자동 재전송하지 않습니다. 제공사 비용은 미확인입니다.' : cause instanceof Error ? cause.message : '의미 검색 실패'); }
    finally { try { update(await refresh()); } catch { setError('의미 색인 목록을 읽지 못했습니다.'); } abort.current = null; setRunning(false); onBusy(false); }
  };
  return <section aria-label="의미 검색" className="reference-hit">
    <h3>선택적 의미 검색 — OpenAI 임베딩 + BM25</h3>
    <p>OpenAI text-embedding-3-small · 512차원 · 색인 세대 {space?.id ?? '없음'} · 제공사 내부 revision 미확인. 원문 색인과 질문 임베딩은 별도 승인이 필요하며 유료 API 요청입니다. PDF 원본·대화·연구 기준은 임베딩 제공사에 보내지 않습니다.</p>
    <p>벡터는 로컬 IndexedDB에 저장합니다. 같은 세대/원문·구간 해시만 재사용하며 세대 간 벡터는 섞지 않습니다. 새 세대는 이전 색인을 보존하지만 재색인 비용이 발생합니다.</p>
    <p>{researchVersionId ? '정본 기준 의미 검색: 현재 프로젝트의 자료 정책/소속/정본을 색인·질문 전송 전후에 확인합니다.' : projectId ? '프로젝트 범위 의미 검색: 선택 프로젝트의 자료 정책을 색인·질문 전송 전후에 확인합니다. 정본 기준은 첨부하지 않습니다.' : '프로젝트와 정본을 선택하지 않은 의미 검색은 작업공간 전체 범위입니다.'} 기존 공유 색인의 이번 선택 자료만 사용합니다.</p>
    <p>활성 검색 세대: {activeGeneration?.spaceId ?? '없음'} · 전환 번호 {activeGeneration?.revision ?? 0}. 새 세대를 만들거나 중단해도 기존 활성 세대는 유지합니다. 전체 추출 구간의 해시 검증과 별도 활성 승인이 필요합니다. 활성 상태는 검색 준비 상태이며 이론 정합성 판정이 아닙니다.</p>
    {!apiKey.trim() && <p>의미 검색은 설정의 OpenAI API 키가 필요합니다. 기존 원문 검색(BM25)은 키 없이 계속 사용할 수 있습니다.</p>}
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    <fieldset disabled={busy}>
      <legend>원문 색인 승인</legend>
      <label>작업할 색인 세대<select value={space?.id ?? ''} onChange={event => { setSpace(spaces.find(s => s.id === event.target.value) ?? null); setPlan(null); setActivation(null); }}>
        {!spaces.length && <option value="">없음</option>}
        {spaces.map(s => <option key={s.id} value={s.id}>{s.id} · {sealedIds.includes(s.id) ? '완성·읽기 전용' : '작성 중/검증 전'}{activeGeneration?.spaceId === s.id ? ' · 활성' : ''}</option>)}
      </select></label>
      <label>이번 색인 최대 요청 횟수<input type="number" min={1} max={100} value={maxRequests} onChange={event => setMaxRequests(Number(event.target.value))} /></label>
      <button type="button" onClick={() => void execute(async () => { setSpace(await createEmbeddingSpace()); setPlan(null); setActivation(null); })}>새 로컬 색인 세대 만들기</button>
      <button type="button" disabled={!selected.length} onClick={() => void execute(async () => {
        const current = space ?? await createEmbeddingSpace(); setSpace(current);
        setPlan({ ...await prepareEmbeddingPlan(current.id, selected, maxRequests, qaxiomDatabase, researchVersionId, projectId), scopeKey }); setQueryPreview(null);
      })}>임베딩 전송 미리보기</button>
      <button type="button" disabled={!space || !selected.length} onClick={() => void execute(async () => {
        if (space) {
          const prepared = await prepareGenerationActivation(space.id, selected);
          const projectScope = await captureEmbeddingScope(researchVersionId, prepared.manifest.sources.map(s => s.id), qaxiomDatabase, projectId);
          setActivation({ ...prepared, scopeKey, projectScope });
        }
      })}>완성 세대 활성화 미리보기</button>
    </fieldset>
    {activationPreview && <section aria-label="색인 활성화 미리보기">
      {activationPreview.projectScope && <p>프로젝트 {activationPreview.projectScope.projectId} · 정책 {activationPreview.projectScope.policyScope ?? '미설정'} · 개정 {activationPreview.projectScope.policyRevision ?? '없음'} · SHA-256 {activationPreview.projectScope.policyHash ?? '없음'}</p>}
      <p>활성화할 세대 {activationPreview.manifest.spaceId} · {activationPreview.manifest.sources.length}자료/{activationPreview.manifest.spans.length}구간 · SHA-256 {activationPreview.manifest.manifestHash}</p>
      {activationPreview.data.references.map(s => <p key={s.id}>{s.name} · {s.contentHash}{s.pdf ? ` · 검색 제외 페이지 ${s.pdf.pages.filter(p => p.status === 'empty').map(p => p.number).join(', ') || '없음'}` : ''}</p>)}
      <p>이 로컬 전환은 API를 호출하지 않습니다. 완성 세대는 읽기 전용으로 고정하고 이전 세대도 보존합니다. 텍스트 없는 PDF 페이지는 전체 추출 구간 완료 여부와 별도로 검색에서 제외됩니다.</p>
      <button type="button" disabled={busy} onClick={() => void execute(async () => {
        await assertEmbeddingScopeCurrent(activationPreview.projectScope, activationPreview.manifest.sources.map(s => s.id));
        await activateGeneration(activationPreview, qaxiomDatabase, activationPreview.projectScope); setActivation(null); setPlan(null); setQueryPreview(null);
        setStatus('검증한 완성 세대를 활성화했습니다. 정합성 판정이 아닌 검색 준비 상태입니다.');
      })}>이 완성 세대 활성화 승인</button>
    </section>}
    {plan && <section aria-label="원문 임베딩 전송 미리보기">
      {plan.projectScope && <p>{plan.projectScope.versionId ? '정본' : '선택'} 프로젝트 {plan.projectScope.projectId} · 정책 {plan.projectScope.policyScope ?? '미설정'} · 개정 {plan.projectScope.policyRevision ?? '없음'} · SHA-256 {plan.projectScope.policyHash ?? '없음'}. 정책의 다른 허용 자료는 전송하지 않습니다.</p>}
      <p>OpenAI {plan.space.model} · {plan.space.dimensions}차원 · 세대 {plan.space.id} · 최대 {plan.batches.length}요청/120초. 아래 신규 구간 텍스트만 전송하며 파일명/페이지는 이 화면에서 원문 확인에 사용합니다. 토큰 한도/금액은 추정하지 않습니다.</p>
      <p>캐시 {plan.cached}구간 · 이번 전송 {plan.batches.flat().length}구간 · 예산상 이번 색인 제외 {plan.omitted.length}구간. 제외 구간은 BM25 검색 가능하지만 의미 색인은 미완료입니다.</p>
      {plan.data.references.filter(source => source.pdf).map(source => <p key={source.id}>{source.name} · 텍스트 없는 페이지: {source.pdf!.pages.filter(p => p.status === 'empty').map(p => p.number).join(', ') || '없음'}. 이 페이지는 두 검색 모두 제외됩니다.</p>)}
      {plan.batches.flat().map(span => <div key={span.id}><p>{plan.data.references.find(source => source.id === span.sourceId)?.name} · {spanLocation(span)} · {span.contentHash}</p><pre>{span.text}</pre></div>)}
      {!!plan.omitted.length && <details><summary>이번 색인에서 제외한 구간</summary>{plan.omitted.map(span => <p key={span.id}>{plan.data.references.find(s => s.id === span.sourceId)?.name} · {spanLocation(span)} · {span.id}</p>)}</details>}
      <button type="button" disabled={busy || !apiKey.trim() || !plan.batches.length} onClick={() => void execute(async signal => {
        await indexEmbeddingPlan(plan, apiKey, signal, (count, tokens) => setStatus(`이번 작업 ${count}구간 저장 · 최근 성공 응답 prompt_tokens ${tokens ?? '미확인'} (누적 비용 아님)`));
        setPlan(null); setStatus('승인한 색인 작업을 저장했습니다. 남은 구간은 미리보기를 다시 만들어 명시적으로 승인하세요.');
      })}>이 원문으로 임베딩 생성 승인</button>
    </section>}
    <fieldset disabled={busy}>
      <legend>질문 임베딩 승인</legend>
      <button type="button" disabled={!selected.length || !query.trim()} onClick={() => void execute(async () => {
        const projectScope = await captureEmbeddingScope(researchVersionId, selected, qaxiomDatabase, projectId);
        const active = await loadActiveGeneration(selected);
        embeddingBody(active.space, [query]);
        await assertEmbeddingScopeCurrent(projectScope, selected);
        setQueryPreview({ scopeKey, query, ...active, projectScope }); setPlan(null);
      })}>의미 검색 질문 전송 미리보기</button>
    </fieldset>
    {queryPreview && <section aria-label="질문 임베딩 전송 미리보기">
      {queryPreview.projectScope && <p>{queryPreview.projectScope.versionId ? '정본' : '선택'} 프로젝트 {queryPreview.projectScope.projectId} · 정책 {queryPreview.projectScope.policyScope ?? '미설정'} · 개정 {queryPreview.projectScope.policyRevision ?? '없음'} · SHA-256 {queryPreview.projectScope.policyHash ?? '없음'}</p>}
      <p>OpenAI {queryPreview.space.model} · {queryPreview.space.dimensions}차원 · 세대 {queryPreview.space.id} · 아래 질문만 1회 전송합니다. 원문은 이번 요청에 포함하지 않습니다.</p>
      <pre>{queryPreview.query}</pre>
      <p>의미 색인 {queryPreview.vectors.length}/{queryPreview.data.referenceSpans.length}구간 · 미색인 {queryPreview.data.referenceSpans.length - queryPreview.vectors.length}구간은 의미 검색에서 제외되지만 BM25에서는 검색합니다. 결과는 RRF(k=60)로 합치며 관련성 후보이지 정합성·진실 확률이 아닙니다.</p>
      <button type="button" disabled={busy || !apiKey.trim()} onClick={() => void execute(async signal => {
        await assertEmbeddingScopeCurrent(queryPreview.projectScope, selected);
        await assertActiveGeneration(queryPreview.activation, queryPreview.data); signal.throwIfAborted();
        const response = await requestEmbeddings(queryPreview.space, [queryPreview.query], apiKey, AbortSignal.any([signal, AbortSignal.timeout(30000)]));
        signal.throwIfAborted();
        await assertEmbeddingScopeCurrent(queryPreview.projectScope, selected);
        const searchWorker = new Worker(new URL('../services/retrieval/search.worker.ts', import.meta.url), { type: 'module' }); worker.current = searchWorker;
        const hits = await new Promise<RetrievalHit[]>((resolve, reject) => {
          const stop = () => { searchWorker.terminate(); reject(new Error('검색 중단')); };
          signal.addEventListener('abort', stop, { once: true });
          searchWorker.onmessage = event => { signal.removeEventListener('abort', stop); searchWorker.terminate(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.hits); };
          searchWorker.onerror = () => { signal.removeEventListener('abort', stop); searchWorker.terminate(); reject(new Error('의미 검색 Worker 실패')); };
          searchWorker.postMessage({ data: queryPreview.data, query: queryPreview.query, hybrid: { space: queryPreview.space, vectors: queryPreview.vectors, queryVector: response.vectors[0] } });
        });
        worker.current = null;
        await assertActiveGeneration(queryPreview.activation, queryPreview.data); signal.throwIfAborted();
        await assertEmbeddingScopeCurrent(queryPreview.projectScope, selected);
        const covered = new Set(queryPreview.vectors.map(v => v.spanId));
        onResults(hits, queryPreview.data, { spaceId: queryPreview.space.id, model: queryPreview.space.model, dimensions: queryPreview.space.dimensions,
          adapterVersion: queryPreview.space.adapterVersion, providerRevision: null, coveredSpanIds: [...covered], missingSpanIds: queryPreview.data.referenceSpans.filter(s => !covered.has(s.id)).map(s => s.id),
          manifestHash: queryPreview.activation.manifestHash, activationRevision: queryPreview.activation.revision });
        setQueryPreview(null); setStatus(`의미/BM25 검색 ${hits.length}개 · 질문 prompt_tokens ${response.promptTokens ?? '미확인'}. 답변 제공사 전송은 근거 선택·미리보기·별도 승인이 필요합니다.`);
      })}>이 질문으로 의미 검색 승인</button>
    </section>}
    {running && <button type="button" onClick={() => abort.current?.abort()}>의미 검색 작업 중단</button>}
  </section>;
}
