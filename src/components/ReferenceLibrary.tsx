import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { importReferenceFile } from '../services/retrieval/references';
import type { ContextBundle, ReferenceDocument, ReferenceRole } from '../services/retrieval/types';
import { registerPdf, processPdf } from '../services/retrieval/pdfIngestion';
import { MAX_PDF_BYTES, type PdfAsset } from '../services/retrieval/pdfTypes';
import './References.css';
import { deleteUnlinkedPdfAsset, deleteUnusedReference } from '../services/retrieval/referenceDeletion';
import {
  FileText, Globe, BookOpen, Trash2, Eye, Plus, Search, Upload, X, Folder
} from 'lucide-react';

const referenceRoleLabel: Record<ReferenceRole, string> = {
  external: '외부 문헌',
  note: '사용자 메모',
  theory_snapshot: '연구노트 스냅샷'
};

const PdfOriginal = lazy(() => import('./PdfOriginal'));
const pdfStatusLabel = {
  pending: '대기',
  running: '추출 중 / 재개 가능',
  ready: '텍스트 추출됨',
  partial: '일부 페이지 텍스트 없음',
  ocr_required: '텍스트 추출 불가 · 검색 제외',
  encrypted: '암호화',
  failed: '실패',
  cancelled: '중단됨'
};

type PdfSummary = Omit<PdfAsset, 'bytes' | 'pages'> & { completedPages: number };
const summarizePdf = ({ bytes: _bytes, pages, ...asset }: PdfAsset): PdfSummary => ({ ...asset, completedPages: pages.length });

export default function ReferenceLibrary({ onClose, canDelete }: {
  onClose: () => void;
  onAsk?: (query: string, bundle: ContextBundle) => void;
  canAsk?: boolean;
  canDelete: boolean;
  modelName?: string;
  embeddingApiKey?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pdfAbort = useRef<AbortController | null>(null);
  const [pdfProcessing, setPdfProcessing] = useState(false);
  const [pdfs, setPdfs] = useState<PdfSummary[]>([]);
  const [original, setOriginal] = useState<{ id: string; name: string } | null>(null);
  const [sources, setSources] = useState<ReferenceDocument[]>([]);
  const [filterQuery, setFilterQuery] = useState('');
  const [isUploadCardOpen, setIsUploadCardOpen] = useState(false);
  const [role, setRole] = useState<ReferenceRole>('external');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    let active = true;
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    void qaxiomDatabase.references.orderBy('createdAt').reverse().toArray()
      .then(result => { if (active) setSources(result); })
      .catch(() => { if (active) setError('레퍼런스 목록을 읽지 못했습니다.'); });
    void qaxiomDatabase.pdf_assets.orderBy('createdAt').reverse().toArray()
      .then(result => { if (active) setPdfs(result.map(summarizePdf)); })
      .catch(() => { if (active) setError('PDF 처리 목록을 읽지 못했습니다.'); });
    return () => { active = false; element?.close(); pdfAbort.current?.abort(); };
  }, []);

  const close = () => { if (!busy) onClose(); };

  const continuePdf = async (id: string) => {
    const controller = new AbortController(); pdfAbort.current = controller; setPdfProcessing(true);
    try {
      const result = await processPdf(id, controller.signal, asset => setPdfs(previous => [summarizePdf(asset), ...previous.filter(item => item.id !== asset.id)]));
      setSources(await qaxiomDatabase.references.orderBy('createdAt').reverse().toArray());
      setStatus(`PDF: ${pdfStatusLabel[result.status]}. ${result.error || ''}`);
    } finally { pdfAbort.current = null; setPdfProcessing(false); }
  };

  const importFile = async (file: File) => {
    setError(''); setStatus(''); setBusy(true);
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
      setStatus(result.duplicate ? '같은 원문이 이미 등록되어 기존 자료를 유지했습니다.' : '새 레퍼런스를 로컬 서고에 저장했습니다.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '파일을 읽지 못했습니다.'); }
    finally { setBusy(false); }
  };

  const removeSource = async (source: ReferenceDocument) => {
    if (!canDelete) { setError('응답 생성이 끝난 뒤 자료를 삭제해 주세요.'); return; }
    if (!window.confirm(`등록 자료 “${source.name}”와 추출 구간${source.pdf ? ' 및 PDF 원본' : ''}을 삭제할까요? 사용 이력이 있으면 삭제되지 않습니다.`)) return;
    setError(''); setStatus(''); setBusy(true);
    try {
      const result = await deleteUnusedReference(source.id, source.contentHash);
      setSources(previous => previous.filter(item => item.id !== source.id));
      if (source.pdf && result.removedPdfAsset) setPdfs(previous => previous.filter(item => item.id !== source.pdf!.assetId));
      setStatus(`사용되지 않은 자료를 삭제했습니다. 추출 구간 ${result.removedSpanCount}개${result.removedPdfAsset ? '와 PDF 원본' : ''}를 함께 정리했습니다.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '자료를 삭제하지 못했습니다.'); }
    finally { setBusy(false); }
  };

  const removeUnlinkedPdf = async (asset: PdfSummary) => {
    if (!canDelete) { setError('응답 생성이 끝난 뒤 PDF 원본을 삭제해 주세요.'); return; }
    if (!window.confirm(`검색 자료로 연결되지 않은 PDF 원본 “${asset.name}”을 로컬에서 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    setError(''); setStatus(''); setBusy(true);
    try {
      await deleteUnlinkedPdfAsset(asset.id, asset.fileHash);
      setPdfs(previous => previous.filter(item => item.id !== asset.id));
      if (original?.id === asset.id) setOriginal(null);
      setStatus('검색 자료로 연결되지 않은 PDF 원본을 삭제했습니다.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'PDF 원본을 삭제하지 못했습니다.'); }
    finally { setBusy(false); }
  };

  const filteredSources = sources.filter(source =>
    source.name.toLowerCase().includes(filterQuery.toLowerCase())
  );

  return (
    <dialog
      ref={dialog}
      className="reference-dialog"
      aria-labelledby="reference-title"
      onCancel={event => { event.preventDefault(); close(); }}
    >
      <header>
        <div className="reference-dialog-title-group">
          <h2 id="reference-title">
            <Folder size={22} style={{ color: '#6366f1' }} />
            <span>Project References</span>
          </h2>
          <p>현재 프로젝트에서 사용 가능한 참고 자료(PDF, 논문, 웹 문서, 연구 메모) 목록입니다.</p>
        </div>
        <button type="button" className="reference-dialog-close-btn" onClick={close} disabled={busy}>
          <X size={16} /> 닫기
        </button>
      </header>

      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}

      {/* 검색 & 업로드 툴바 */}
      <div className="ref-catalog-toolbar">
        <div className="ref-search-bar">
          <Search size={16} />
          <input
            type="text"
            placeholder="등록된 레퍼런스 파일 이름 검색..."
            value={filterQuery}
            onChange={e => setFilterQuery(e.target.value)}
          />
          {filterQuery && (
            <button
              type="button"
              style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer' }}
              onClick={() => setFilterQuery('')}
            >
              <X size={14} />
            </button>
          )}
        </div>

        <button
          type="button"
          className="ref-add-toggle-btn"
          onClick={() => setIsUploadCardOpen(prev => !prev)}
        >
          {isUploadCardOpen ? <X size={16} /> : <Plus size={16} />}
          <span>{isUploadCardOpen ? '등록 창 닫기' : '새 레퍼런스 등록'}</span>
        </button>
      </div>

      {/* 새 레퍼런스 등록 카드 (토글) */}
      {isUploadCardOpen && (
        <div className="ref-upload-card">
          <h3>
            <Upload size={18} style={{ color: '#818cf8' }} />
            <span>새 레퍼런스 자료 등록</span>
          </h3>
          <div className="ref-upload-grid">
            <div className="ref-upload-field">
              <label htmlFor="reference-role">자료 분류 종류</label>
              <select id="reference-role" value={role} onChange={event => setRole(event.target.value as ReferenceRole)}>
                {Object.entries(referenceRoleLabel).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>
            <div className="ref-upload-field">
              <label htmlFor="reference-file">파일 선택 (Markdown, TXT, PDF)</label>
              <input
                id="reference-file"
                type="file"
                accept=".md,.markdown,.txt,.pdf"
                onChange={event => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void importFile(file);
                }}
              />
            </div>
          </div>
          <p className="ref-upload-hint">
            • Markdown/TXT 파일은 최대 2 MB, PDF 파일은 최대 20 MB / 300쪽까지 지원됩니다.<br />
            • 등록된 모든 자료는 LLM Wiki 서고로 자동 일원화되어 정합성이 보존됩니다.
          </p>
        </div>
      )}

      {/* PDF 추출 처리 상태 카드 */}
      {!!pdfs.length && (
        <section aria-label="PDF 처리 상태" style={{ marginBottom: '20px' }}>
          <h4 style={{ fontSize: '0.9rem', color: '#cbd5e1', marginBottom: '10px' }}>PDF 처리 및 추출 상태</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {pdfs.map(asset => (
              <div key={asset.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.03)', padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.06)' }}>
                <span style={{ fontSize: '0.85rem', color: '#e2e8f0' }}>
                  <strong>{asset.name}</strong> · {pdfStatusLabel[asset.status]} ({asset.completedPages}/{asset.pageCount || '?'}쪽)
                </span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button type="button" className="ref-action-btn" disabled={busy} onClick={() => setOriginal({ id: asset.id, name: asset.name })}>
                    <Eye size={13} /> PDF 원본 보기
                  </button>
                  {['pending', 'running', 'cancelled', 'failed'].includes(asset.status) && (
                    <button type="button" className="ref-action-btn" disabled={busy} onClick={() => {
                      setBusy(true);
                      void continuePdf(asset.id).catch(cause => setError(String(cause))).finally(() => setBusy(false));
                    }}>
                      추출 재개
                    </button>
                  )}
                  {!sources.some(source => source.pdf?.assetId === asset.id) && (
                    <button type="button" className="ref-action-btn delete" disabled={busy || pdfProcessing || !canDelete || asset.status === 'running'} onClick={() => void removeUnlinkedPdf(asset)}>
                      PDF 삭제
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 메인 레퍼런스 카탈로그 리스트 (카드 스타일) */}
      <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f1f5f9', marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>프로젝트 등록 자료 목록 ({filteredSources.length}건)</span>
      </h3>

      {filteredSources.length === 0 ? (
        <div className="ref-empty-box">
          <Folder size={36} style={{ color: '#64748b', opacity: 0.6 }} />
          <h4>등록된 레퍼런스가 없습니다</h4>
          <p>연구에 사용할 논문(PDF), Markdown 메모, 웹 문서 자료를 등록해 보세요.</p>
          <button
            type="button"
            className="ref-add-toggle-btn"
            onClick={() => setIsUploadCardOpen(true)}
          >
            <Plus size={16} /> 레퍼런스 파일 추가하기
          </button>
        </div>
      ) : (
        <div className="ref-card-list">
          {filteredSources.map(source => {
            const isPdf = Boolean(source.pdf);
            const isTheory = source.role === 'theory_snapshot';
            const isNote = source.role === 'note';

            return (
              <div className="ref-card" key={source.id}>
                <div className="ref-card-left">
                  <div className={`ref-card-icon ${isPdf ? 'pdf' : isTheory ? 'theory_snapshot' : isNote ? 'note' : 'external'}`}>
                    {isPdf ? <FileText size={20} /> : isTheory ? <BookOpen size={20} /> : isNote ? <FileText size={20} /> : <Globe size={20} />}
                  </div>
                  <div className="ref-card-info">
                    <div className="ref-card-header-line">
                      <span className="ref-card-title">{source.name}</span>
                      <span className={`ref-role-badge ${source.role}`}>
                        {referenceRoleLabel[source.role]}
                      </span>
                    </div>

                    <div className="ref-card-meta">
                      <span>등록일: {new Date(source.createdAt).toLocaleDateString()}</span>
                      <span>•</span>
                      <span>SHA: <code className="ref-card-hash">{source.contentHash.slice(0, 10)}</code></span>
                      {source.pdf && (
                        <>
                          <span>•</span>
                          <span>PDF {source.pdf.pageCount}쪽</span>
                          {source.pdf.pages.some(p => p.status === 'empty') && (
                            <span style={{ color: '#f87171' }}>
                              (텍스트 미포함 {source.pdf.pages.filter(p => p.status === 'empty').length}쪽)
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="ref-card-actions">
                  {source.pdf && (
                    <button
                      type="button"
                      className="ref-action-btn"
                      disabled={busy}
                      onClick={() => setOriginal({ id: source.pdf!.assetId, name: source.name })}
                    >
                      <Eye size={13} /> 원본 보기
                    </button>
                  )}
                  <button
                    type="button"
                    className="ref-action-btn delete"
                    disabled={!canDelete}
                    aria-label={`등록 자료 삭제: ${source.name}`}
                    onClick={() => void removeSource(source)}
                  >
                    <Trash2 size={13} /> 삭제
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {original && (
        <Suspense fallback={<p role="status">PDF 뷰어 불러오는 중…</p>}>
          <PdfOriginal {...original} onClose={() => setOriginal(null)} />
        </Suspense>
      )}
    </dialog>
  );
}
