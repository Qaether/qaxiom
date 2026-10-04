import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { importReferenceFile, loadReferenceSelection } from '../services/retrieval/references';
import { assembleContext } from '../services/retrieval/assembly';
import type { ContextBundle, ReferenceData, ReferenceDocument, ReferenceRole, RetrievalHit } from '../services/retrieval/types';
import { listTheories, loadTheory } from '../services/theory/documents';
import type { DocumentVersion, TheorySnapshot } from '../services/theory/types';
import { assertGraphContextCurrent, prepareGraphContext } from '../services/retrieval/graphContext';
import { registerPdf, processPdf } from '../services/retrieval/pdfIngestion';
import { MAX_PDF_BYTES, spanLocation, type PdfAsset } from '../services/retrieval/pdfTypes';
import './References.css';
import SemanticRetrieval from './SemanticRetrieval';
import type { HybridTrace } from '../services/retrieval/embeddingTypes';
import CanonicalSearch from './CanonicalSearch';
import { assertRagProjectScopeCurrent, assertRagSearchScope, prepareRagProjectScope } from '../services/retrieval/projectScope';
import { deleteUnlinkedPdfAsset, deleteUnusedReference } from '../services/retrieval/referenceDeletion';

const referenceRoleLabel = { external: '외부 문헌', note: '사용자 메모', theory_snapshot: '자체 문서 — 외부 증거 아님' };
const PdfOriginal = lazy(() => import('./PdfOriginal'));
const pdfStatusLabel = { pending: '대기', running: '추출 중 / 재개 가능', ready: '텍스트 추출됨', partial: '일부 페이지 텍스트 없음', ocr_required: '텍스트 추출 불가 · 검색 제외', encrypted: '암호화', failed: '실패', cancelled: '중단됨' };
type PdfSummary = Omit<PdfAsset, 'bytes' | 'pages'> & { completedPages: number };
const summarizePdf = ({ bytes: _bytes, pages, ...asset }: PdfAsset): PdfSummary => ({ ...asset, completedPages: pages.length });

export default function ReferenceLibrary({ onClose, onAsk, canAsk, canDelete, modelName, embeddingApiKey }: {
  onClose: () => void; onAsk: (query: string, bundle: ContextBundle) => void; canAsk: boolean; canDelete: boolean; modelName: string; embeddingApiKey: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const worker = useRef<Worker | null>(null);
  const pdfAbort = useRef<AbortController | null>(null);
  const [pdfProcessing, setPdfProcessing] = useState(false);
  const [pdfs, setPdfs] = useState<PdfSummary[]>([]);
  const [original, setOriginal] = useState<{ id: string; name: string } | null>(null);
  const [sources, setSources] = useState<ReferenceDocument[]>([]);
  const [researchVersions, setResearchVersions] = useState<DocumentVersion[]>([]);
  const [researchId, setResearchId] = useState('');
  const [graphSnapshot, setGraphSnapshot] = useState<TheorySnapshot | null>(null);
  const [graphTargets, setGraphTargets] = useState<string[]>([]);
  const [includeGraph, setIncludeGraph] = useState(false);
  const [previewModel, setPreviewModel] = useState('');
  const [searchData, setSearchData] = useState<ReferenceData | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [role, setRole] = useState<ReferenceRole>('external');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<RetrievalHit[]>([]);
  const [hybridTrace, setHybridTrace] = useState<HybridTrace | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [bundle, setBundle] = useState<ContextBundle | null>(null);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    const element = dialog.current!; element.showModal();
    let active = true;
    void qaxiomDatabase.references.orderBy('createdAt').reverse().toArray()
      .then(result => { if (active) setSources(result); })
      .catch(() => { if (active) setError('자료 목록을 불러오지 못했습니다. 닫은 뒤 다시 열어 주세요.'); });
    void qaxiomDatabase.pdf_assets.orderBy('createdAt').reverse().toArray()
      .then(result => { if (active) setPdfs(result.map(summarizePdf)); })
      .catch(() => { if (active) setError('PDF 처리 목록을 읽지 못했습니다.'); });
    void listTheories().then(result => { if (active) setResearchVersions(result.map(item => item.version)); })
      .catch(() => { if (active) setError('연구 기준 목록을 불러오지 못했습니다.'); });
    return () => { active = false; element.close(); worker.current?.terminate(); pdfAbort.current?.abort(); };
  }, []);
  const clearResults = () => { setHits([]); setHybridTrace(null); setChosen([]); setBundle(null); setSearchData(null); setStatus(''); setError(''); };
  const close = () => { if (!busy) onClose(); };
  const continuePdf = async (id: string) => {
    const controller = new AbortController(); pdfAbort.current = controller; setPdfProcessing(true);
    try {
      const result = await processPdf(id, controller.signal, asset => setPdfs(previous => [summarizePdf(asset), ...previous.filter(item => item.id !== asset.id)]));
      setSources(await qaxiomDatabase.references.orderBy('createdAt').reverse().toArray());
      if (['ready', 'partial'].includes(result.status)) setSelected(previous => [...new Set([...previous, `pdf-${id}`])]);
      setStatus(`PDF: ${pdfStatusLabel[result.status]}. ${result.error}`);
    } finally { pdfAbort.current = null; setPdfProcessing(false); }
  };
  const importFile = async (file: File) => {
    clearResults(); setBusy(true);
    try {
      if (/\.pdf$/i.test(file.name)) {
        if (file.size > MAX_PDF_BYTES) throw new Error('PDF는 파일당 20 MB 이하여야 합니다.');
        const result = await registerPdf(file.name, await file.arrayBuffer(), role);
        setPdfs(previous => [summarizePdf(result.asset), ...previous.filter(asset => asset.id !== result.asset.id)]);
        await continuePdf(result.asset.id);
        return;
      }
      const result = await importReferenceFile(file, role);
      setSources(await qaxiomDatabase.references.orderBy('createdAt').reverse().toArray());
      setSelected(previous => [...new Set([...previous, result.source.id])]);
      setStatus(result.duplicate ? '같은 원문이 이미 등록되어 기존 자료를 선택했습니다.' : '레퍼런스를 로컬에 저장했습니다.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '파일을 읽지 못했습니다.'); }
    finally { setBusy(false); }
  };
  const removeSource = async (source: ReferenceDocument) => {
    if (!canDelete) { setError('응답 생성이 끝난 뒤 자료를 삭제해 주세요.'); return; }
    if (!window.confirm(`등록 자료 “${source.name}”와 추출 구간${source.pdf ? ' 및 PDF 원본' : ''}을 삭제할까요? 사용 이력이 있으면 삭제하지 않습니다. 이 작업은 되돌릴 수 없습니다.`)) return;
    clearResults(); setBusy(true);
    try {
      const result = await deleteUnusedReference(source.id, source.contentHash);
      setSources(previous => previous.filter(item => item.id !== source.id));
      setSelected(previous => previous.filter(id => id !== source.id));
      if (source.pdf && result.removedPdfAsset) setPdfs(previous => previous.filter(item => item.id !== source.pdf!.assetId));
      setStatus(`사용되지 않은 자료를 삭제했습니다. 추출 구간 ${result.removedSpanCount}개${result.removedPdfAsset ? '와 PDF 원본' : ''}를 함께 정리했습니다.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '자료를 삭제하지 못했습니다.'); }
    finally { setBusy(false); }
  };
  const removeUnlinkedPdf = async (asset: PdfSummary) => {
    if (!canDelete) { setError('응답 생성이 끝난 뒤 PDF 원본을 삭제해 주세요.'); return; }
    if (!window.confirm(`검색 자료로 연결되지 않은 PDF 원본 “${asset.name}”을 로컬에서 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    clearResults(); setBusy(true);
    try {
      await deleteUnlinkedPdfAsset(asset.id, asset.fileHash);
      setPdfs(previous => previous.filter(item => item.id !== asset.id));
      if (original?.id === asset.id) setOriginal(null);
      setStatus('검색 자료로 연결되지 않은 PDF 원본을 삭제했습니다.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'PDF 원본을 삭제하지 못했습니다.'); }
    finally { setBusy(false); }
  };
  const search = async () => {
    clearResults(); setBusy(true);
    try {
      await assertRagSearchScope(researchId, selected, qaxiomDatabase);
      const data = await loadReferenceSelection(selected);
      setSearchData(data);
      const searchWorker = new Worker(new URL('../services/retrieval/search.worker.ts', import.meta.url), { type: 'module' });
      worker.current = searchWorker;
      setSearching(true);
      searchWorker.onmessage = (event: MessageEvent<{ hits?: RetrievalHit[]; error?: string }>) => {
        searchWorker.terminate(); worker.current = null; setBusy(false); setSearching(false);
        if (event.data.error) { setError(event.data.error); return; }
        const result = event.data.hits || [];
        setHits(result); setChosen(result.slice(0, 3).map(hit => hit.span.id));
        setStatus(result.length ? `검색 결과 ${result.length}개. 전송할 근거를 선택해 주세요.` : '일치하는 원문이 없습니다. 용어를 바꾸거나 자료를 추가해 주세요.');
      };
      searchWorker.onerror = () => {
        searchWorker.terminate(); worker.current = null; setBusy(false); setSearching(false); setError('검색 Worker 실행에 실패했습니다. 다시 시도해 주세요.');
      };
      searchWorker.postMessage({ data, query });
    } catch (cause) { setBusy(false); setError(cause instanceof Error ? cause.message : '검색에 실패했습니다.'); }
  };
  return <dialog ref={dialog} className="reference-dialog" aria-labelledby="reference-title"
    onCancel={event => { event.preventDefault(); close(); }}>
    <header><div><h2 id="reference-title">레퍼런스 검색</h2>
      <p>선택한 원문에서 검색합니다. 검색 결과는 전체 문서의 정합성 판정이 아닙니다.</p></div>
      <button type="button" onClick={close} disabled={busy}>닫기</button></header>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    <fieldset disabled={busy}>
      <legend>자료 등록 · Markdown/TXT 2 MB · PDF 20 MB / 300쪽</legend>
      <label htmlFor="reference-role">첨부 문서 종류</label>
      <select id="reference-role" value={role} onChange={event => setRole(event.target.value as ReferenceRole)}>
        {Object.entries(referenceRoleLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <label htmlFor="reference-file">레퍼런스 파일</label>
      <input id="reference-file" type="file" accept=".md,.markdown,.txt,.pdf" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file);
      }} />
      <p>자체 작성·AI 생성 문서는 해당 종류로 지정하세요. 저장된 정본과 추출 텍스트 해시가 같으면 자동으로 자체 문서로 분류합니다. 수정된 재첨부본은 자동 판별하지 못합니다. PDF는 로컬에서 처리하며 다단 편집·표·수식의 읽기 순서를 보증하지 않습니다.</p>
    </fieldset>
    {!!pdfs.length && <section aria-label="PDF 처리 상태">
      <h3>PDF 원본과 추출 상태</h3>
      {pdfs.map(asset => <article className="reference-hit" key={asset.id}>
        <p>{asset.name} · {pdfStatusLabel[asset.status]} · {asset.completedPages}/{asset.pageCount || '?'}쪽</p>
        {asset.error && <p>{asset.error}</p>}
        <button type="button" disabled={busy} onClick={() => setOriginal({ id: asset.id, name: asset.name })}>PDF 원본 보기: {asset.name}</button>
        {['pending', 'running', 'cancelled', 'failed'].includes(asset.status) && <button type="button" disabled={busy} onClick={() => {
          clearResults(); setBusy(true);
          void continuePdf(asset.id).catch(cause => setError(String(cause))).finally(() => setBusy(false));
        }}>추출 재개: {asset.name}</button>}
        {!sources.some(source => source.pdf?.assetId === asset.id) && <button type="button" disabled={busy || pdfProcessing || !canDelete || asset.status === 'running'}
          aria-label={`미연결 PDF 원본 삭제: ${asset.name}`} onClick={() => void removeUnlinkedPdf(asset)}>PDF 원본 삭제</button>}
      </article>)}
    </section>}
    {pdfProcessing && <button type="button" onClick={() => pdfAbort.current?.abort()}>PDF 추출 중단</button>}
    <fieldset disabled={busy}>
      <legend>이번 질문의 검색 범위</legend>
      {!sources.length && <p>레퍼런스 검색은 자료를 등록하고, 정본 단독 질문은 아래에서 연구 기준을 선택하세요.</p>}
      {sources.map(source => <div className="reference-choice-row" key={source.id}>
        <label className="reference-choice">
          <input type="checkbox" checked={selected.includes(source.id)} onChange={event => {
            clearResults(); setSelected(previous => event.target.checked ? [...previous, source.id] : previous.filter(id => id !== source.id));
          }} />
          <span>{source.name} · {referenceRoleLabel[source.role]} · {source.contentHash.slice(0, 8)}{source.pdf && ` · PDF ${source.pdf.pageCount}쪽 · 텍스트 없는 페이지 ${source.pdf.pages.filter(page => page.status === 'empty').length}개`}</span>
        </label>
        <button type="button" className="reference-delete-btn" disabled={!canDelete} aria-label={`등록 자료 삭제: ${source.name}`} onClick={() => void removeSource(source)}>삭제</button>
      </div>)}
      {!!sources.length && <p>삭제는 과거 답변·검토·관계·프로젝트 정책·임베딩에 사용되지 않은 자료만 허용합니다. 사용 이력은 먼저 백업하고 보존하세요.</p>}
      <label htmlFor="reference-research">필수 연구 기준 (정본 버전 선택)</label>
      <select id="reference-research" value={researchId} onChange={event => {
        const id = event.target.value; setResearchId(id); setBundle(null); setError(''); setGraphSnapshot(null); setGraphTargets([]); setIncludeGraph(false);
        const version = researchVersions.find(v => v.id === id);
        if (version) { setBusy(true); void loadTheory(version.documentId).then(value => {
          if (value.version.id !== id) throw new Error('정본 버전이 변경되었습니다. 닫은 뒤 연구 기준을 다시 선택하세요.');
          setGraphSnapshot(value);
        }).catch(cause => setError(String(cause))).finally(() => setBusy(false)); }
      }}>
        <option value="">연구 기준 첨부 안 함</option>
        {researchVersions.map(version => <option key={version.id} value={version.id}>{version.title} · v{version.number}</option>)}
      </select>
      <p>선택한 버전의 ResearchContract 전체를 검색 순위와 무관하게 첨부합니다. 정본 본문 전체는 자동 전송하지 않습니다.</p>
      <p>정본을 선택하면 해당 프로젝트의 ResearchContract도 첨부하고 자료 정책을 검색·전송 전후에 확인합니다. 정본과 프로젝트를 모두 선택하지 않은 검색만 작업공간 전체 범위입니다.</p>
      {graphSnapshot && <section aria-label="답변 그래프 범위">
        <label><input type="checkbox" checked={includeGraph} onChange={event => { setIncludeGraph(event.target.checked); setBundle(null); }} />답변에 승인 그래프 전제·정의 포함</label>
        {includeGraph && <>
          <p>목표 정본 블록을 직접 선택하세요. 승인된 의존·정의 경로의 추가 전제도 미리보기에서 확인합니다. 자체 문서는 외부 증거가 아니며 선택하지 않은 외부 관계는 보내지 않습니다.</p>
          <CanonicalSearch key={`${graphSnapshot.version.id}:${query}`} snapshot={graphSnapshot} query={query} selected={graphTargets} onSelect={id => {
            setBundle(null); setGraphTargets(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]);
          }} />
          {graphSnapshot.blocks.map(block => <label key={block.id} className="reference-choice"><input type="checkbox" checked={graphTargets.includes(block.id)} onChange={event => {
            setBundle(null); setGraphTargets(previous => event.target.checked ? [...previous, block.id] : previous.filter(id => id !== block.id));
          }} /><span>그래프 목표 블록 {block.position + 1} · {block.text.slice(0, 100)}</span></label>)}
        </>}
      </section>}
      <label htmlFor="reference-query">레퍼런스에 질문</label>
      <textarea id="reference-query" rows={3} value={query} onChange={event => { setQuery(event.target.value); clearResults(); }} />
      <button type="button" disabled={!query.trim() || !selected.length} onClick={() => void search()}>원문 검색</button>
      {includeGraph && graphSnapshot && <>
        <p>정본 단독 질문은 등록하거나 선택한 레퍼런스를 첨부하지 않습니다. 기존 대화는 함께 전송하므로 원문 없이 시작하려면 새 대화를 사용하세요.</p>
        <button type="button" disabled={!query.trim() || !graphTargets.length} onClick={() => {
          setBusy(true); setBundle(null); setError('');
          void prepareGraphContext(graphSnapshot, graphTargets).then(async graph => {
            const result = assembleContext(query, [], [], { references: [], referenceSpans: [] }, graphSnapshot.version, graph);
            const prepared = await prepareRagProjectScope(result);
            setPreviewModel(modelName); setBundle(prepared);
          }).catch(cause => setError(cause instanceof Error ? cause.message : '정본 문맥 생성 실패')).finally(() => setBusy(false));
        }}>정본만으로 질문 미리보기</button>
      </>}
    </fieldset>
    <SemanticRetrieval selected={selected} query={query} researchVersionId={researchId} projectId="" apiKey={embeddingApiKey} busy={busy} onBusy={value => { setBusy(value); if (value) { setBundle(null); setStatus(''); setError(''); } }}
      onResults={(result, data, trace) => { setSearchData(data); setHybridTrace(trace); setHits(result); setChosen(result.slice(0, 3).map(hit => hit.span.id)); setBundle(null); setStatus(`검색 결과 ${result.length}개. 전송할 근거를 선택해 주세요.`); }} />
    {busy && <p role="status">자료 처리 중…</p>}
    {searching && <button type="button" onClick={() => {
      worker.current?.terminate(); worker.current = null; setBusy(false); setSearching(false); setStatus('검색을 중단했습니다.');
    }}>검색 중단</button>}
    {!!hits.length && <section aria-label="검색 근거">
      <h3>전송할 원문 선택</h3>
      <p>{hybridTrace ? '벡터 관련성 + BM25의 RRF(k=60) 후보 순위입니다.' : 'BM25 용어 검색 기준선입니다.'} 점수는 정합성·진실 확률이 아닙니다.</p>
      {hits.map(hit => <article className="reference-hit" key={hit.span.id}>
        <label className="reference-choice"><input type="checkbox" disabled={busy} checked={chosen.includes(hit.span.id)} onChange={event => {
          setBundle(null); setChosen(previous => event.target.checked ? [...previous, hit.span.id] : previous.filter(id => id !== hit.span.id));
        }} /><span>{hit.source.name} · {spanLocation(hit.span)} · {referenceRoleLabel[hit.source.role]} · 점수 {hit.score.toFixed(3)}</span></label>
        <pre>{hit.span.text}</pre>
      </article>)}
      <button type="button" disabled={busy || !chosen.length || (includeGraph && !graphTargets.length)} onClick={() => { void (async () => {
        setBusy(true); setBundle(null);
        try {
          setError('');
          if (!searchData) throw new Error('다시 검색해 주세요.');
          const graph = includeGraph && graphSnapshot ? await prepareGraphContext(graphSnapshot, graphTargets) : undefined;
          const assembled = assembleContext(query, selected, hits.filter(hit => chosen.includes(hit.span.id)), searchData,
            researchVersions.find(version => version.id === researchId) ?? null, graph);
          setPreviewModel(modelName);
          setBundle(await prepareRagProjectScope(hybridTrace ? { ...assembled, retriever: 'hybrid-rrf-v1', hybrid: hybridTrace } : assembled));
        }
        catch (cause) { setError(cause instanceof Error ? cause.message : '전송할 근거를 확인해 주세요.'); }
        finally { setBusy(false); }
      })(); }}>전송 내용 미리보기</button>
    </section>}
    {bundle && previewModel === modelName && <section className="reference-preview" aria-label="전송 미리보기">
      <h3>선택 모델: {modelName}</h3>
      <p>현재 대화와 질문, 아래 원문 구간·파일명·종류·출처 ID가 선택 모델의 제공사로 전송됩니다. 선택하지 않은 자료의 원문은 추가하지 않습니다. 관련 내용이 기존 대화에 있으면 대화와 함께 전송됩니다.</p>
      <p>질문: {bundle.query}</p>
      {bundle.projectScope && <p>프로젝트 {bundle.projectScope.projectId} · 자료 정책 {bundle.projectScope.policyRevision === null ? '미설정 (명시적 자료 선택)' : `개정 ${bundle.projectScope.policyRevision}`} · {bundle.projectScope.policyScope === 'research' ? '프로젝트 RAG 허용 목록 적용' : '프로젝트 RAG 자료 제한 없음'} · 정책 SHA-256 {bundle.projectScope.policyHash ?? '없음'}.</p>}
      {bundle.retriever === 'graph-canonical-v1' && <p>정본 단독 문맥 · 이번 요청의 레퍼런스 원문 0개. 외부 근거 없이 선택 목표/승인 전제만 첨부합니다. 자체 문서에서 답변을 생성하더라도 참·정합성·외부 호환성 증명이 아닙니다.</p>}
      {bundle.hybrid && <p>검색 세대 {bundle.hybrid.spaceId} · {bundle.hybrid.model}/{bundle.hybrid.dimensions}차원 · 의미 색인 {bundle.hybrid.coveredSpanIds.length}구간/미색인 {bundle.hybrid.missingSpanIds.length}구간 · 제공사 revision 미확인. 검색 범위 통과는 전체 정합성 검사가 아닙니다.</p>}
      <p>원문 {bundle.evidence.length}/8개 · 원문과 연구 기준/그래프 {bundle.evidence.reduce((sum, item) => sum + item.span.text.length, 0) + (bundle.assembly?.research ? JSON.stringify(bundle.assembly.research).length : 0) + (bundle.graph ? JSON.stringify(bundle.graph).length : 0)}/12,000자 (UTF-16). 전체 대화·메타데이터는 요청 시 UTF-8 48 KB 한도를 추가 검사하며 모델별 토큰 보장은 아닙니다.</p>
      {bundle.graph && <section aria-label="전송할 정본 그래프">
        <p>그래프 목표 {bundle.graph.context.targetBlockIds.length}블록 · 추가 전제 {bundle.graph.context.premiseBlockIds.length}블록 · 승인 관계 {bundle.graph.context.relationSnapshots.length}개. [[G1]]은 자체 정본 원문이며 독립 외부 증거가 아닙니다. 첨부는 검사 완료가 아닙니다.</p>
        <pre>{JSON.stringify(bundle.graph.context, null, 2)}</pre>
        {bundle.graph.blocks.map((block, index) => <div key={block.id}><p>[[G{index + 1}]] {bundle.graph?.context.targetBlockIds.includes(block.id) ? '목표' : '추가 전제'} · 블록 {block.id} · SHA-256 {block.contentHash}</p><pre>{block.text}</pre></div>)}
      </section>}
      <p>부모 문맥 추가 {bundle.assembly?.parentSpanIds.length ?? 0}개 · 예산 초과로 제외 {bundle.assembly?.omittedSpanIds.length ?? 0}개. Markdown 제목 계층/PDF 동일 페이지 기준이며 의미 의존성 검사가 아닙니다.</p>
      {!!bundle.assembly?.omissions.length && <ul>{bundle.assembly.omissions.map(item =>
        <li key={item.spanId}>{item.name} · {spanLocation(item)} · 문맥 예산 초과 (미전송)</li>)}</ul>}
      {bundle.assembly?.research ? <div>
        <h4>필수 연구 기준: {bundle.assembly.research.title} · v{bundle.assembly.research.number}</h4>
        <p>버전 ID: {bundle.assembly.research.versionId} · 본문 해시: {bundle.assembly.research.contentHash}</p>
        <p>비어 있는 항목: {bundle.assembly.research.emptyFields.join(', ') || '없음'}. 사용자가 선언한 기준이며 외부 증거가 아닙니다.</p>
        <pre>{JSON.stringify(bundle.assembly.research.contract, null, 2)}</pre>
        {bundle.assembly.research.contractAnchors && <p>정본 원문 연결: {JSON.stringify(bundle.assembly.research.contractAnchors)}. 연결 블록의 본문은 선택된 정본 그래프에 포함되지 않았다면 전송하지 않습니다.</p>}
      </div> : <p>연구 기준 미첨부 — 필수 전제의 완전성을 확인하지 않았습니다.</p>}
      {bundle.evidence.map(item => <div key={item.citationId}><strong>[[{item.citationId}]] {item.name} · {spanLocation(item.span)} · {referenceRoleLabel[item.role]}</strong>
        {item.pdf && <p>PDF 추출 텍스트 · 전체 {item.pdf.pageCount}쪽 · 텍스트 없는 페이지: {item.pdf.emptyPages.join(', ') || '없음'}. 원본 바이트는 제공사에 전송하지 않습니다.</p>}
        <pre>{item.span.text}</pre></div>)}
      {!canAsk && <p>설정에서 API 키를 등록하고 진행 중인 답변이 끝난 뒤 질문할 수 있습니다.</p>}
      <button type="button" disabled={busy || !canAsk} onClick={() => { setBusy(true); setError(''); void assertRagProjectScopeCurrent(bundle).then(() => assertGraphContextCurrent(bundle)).then(() => onAsk(bundle.query, bundle))
        .catch(cause => setError(cause instanceof Error ? cause.message : '문맥 재확인 실패')).finally(() => setBusy(false)); }}>이 근거로 질문 보내기</button>
    </section>}
    {original && <Suspense fallback={<p role="status">PDF 뷰어 불러오는 중…</p>}><PdfOriginal {...original} onClose={() => setOriginal(null)} /></Suspense>}
  </dialog>;
}
