import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { importReferenceFile } from '../services/retrieval/references';
import type { ContextBundle, ReferenceDocument, ReferenceRole } from '../services/retrieval/types';
import { registerPdf, processPdf } from '../services/retrieval/pdfIngestion';
import { MAX_PDF_BYTES, type PdfAsset } from '../services/retrieval/pdfTypes';
import './References.css';
import { deleteUnlinkedPdfAsset, deleteUnusedReference } from '../services/retrieval/referenceDeletion';
import {
  FileText, Globe, BookOpen, Trash2, Eye, Plus, Upload, X, Folder
} from 'lucide-react';

const referenceRoleLabel: Record<ReferenceRole, string> = {
  external: 'External Literature',
  note: 'User Note',
  theory_snapshot: 'Research Note Snapshot'
};

const PdfOriginal = lazy(() => import('./PdfOriginal'));
const pdfStatusLabel = {
  pending: 'Pending',
  running: 'Extracting / Resumable',
  ready: 'Text Extracted',
  partial: 'Some Pages Lack Text',
  ocr_required: 'Text Unavailable · Excluded from Search',
  encrypted: 'Encrypted',
  failed: 'Failed',
  cancelled: 'Cancelled'
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
      .catch(() => { if (active) setError('Failed to load the reference list.'); });
    void qaxiomDatabase.pdf_assets.orderBy('createdAt').reverse().toArray()
      .then(result => { if (active) setPdfs(result.map(summarizePdf)); })
      .catch(() => { if (active) setError('Failed to load the PDF processing list.'); });
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
        if (file.size > MAX_PDF_BYTES) throw new Error('PDF files must be 20 MB or smaller.');
        const result = await registerPdf(file.name, await file.arrayBuffer(), role);
        setPdfs(previous => [summarizePdf(result.asset), ...previous.filter(asset => asset.id !== result.asset.id)]);
        await continuePdf(result.asset.id);
        return;
      }
      const result = await importReferenceFile(file, role);
      setSources(await qaxiomDatabase.references.orderBy('createdAt').reverse().toArray());
      setStatus(result.duplicate ? 'Identical source already registered; kept the existing reference.' : 'Saved new reference to the local library.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to read the file.'); }
    finally { setBusy(false); }
  };

  const removeSource = async (source: ReferenceDocument) => {
    if (!canDelete) { setError('Please wait until response generation finishes before deleting a reference.'); return; }
    if (!window.confirm(`Delete registered reference "${source.name}", its extracted spans${source.pdf ? ', and the original PDF' : ''}? It will not be deleted if it has usage history.`)) return;
    setError(''); setStatus(''); setBusy(true);
    try {
      const result = await deleteUnusedReference(source.id, source.contentHash);
      setSources(previous => previous.filter(item => item.id !== source.id));
      if (source.pdf && result.removedPdfAsset) setPdfs(previous => previous.filter(item => item.id !== source.pdf!.assetId));
      setStatus(`Deleted unused reference. Cleaned up ${result.removedSpanCount} extracted spans${result.removedPdfAsset ? ' and the original PDF' : ''}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to delete the reference.'); }
    finally { setBusy(false); }
  };

  const removeUnlinkedPdf = async (asset: PdfSummary) => {
    if (!canDelete) { setError('Please wait until response generation finishes before deleting the original PDF.'); return; }
    if (!window.confirm(`Delete unlinked original PDF "${asset.name}" from local storage? This action cannot be undone.`)) return;
    setError(''); setStatus(''); setBusy(true);
    try {
      await deleteUnlinkedPdfAsset(asset.id, asset.fileHash);
      setPdfs(previous => previous.filter(item => item.id !== asset.id));
      if (original?.id === asset.id) setOriginal(null);
      setStatus('Deleted the unlinked original PDF.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to delete the original PDF.'); }
    finally { setBusy(false); }
  };

  const pendingOrIssuePdfs = pdfs.filter(
    asset => asset.status !== 'ready' || !sources.some(source => source.pdf?.assetId === asset.id)
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
          <p>List of reference materials (PDFs, papers, web documents, research notes) available in the current project.</p>
        </div>
        <button
          type="button"
          className="reference-dialog-close-btn"
          onClick={close}
          disabled={busy}
          aria-label="Close"
          title="Close"
        >
          <X size={16} />
        </button>
      </header>

      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}

      {/* Upload Toolbar */}
      <div className="ref-catalog-toolbar">
        <button
          type="button"
          className="ref-add-toggle-btn"
          onClick={() => setIsUploadCardOpen(prev => !prev)}
        >
          {isUploadCardOpen ? <X size={16} /> : <Plus size={16} />}
          <span>{isUploadCardOpen ? 'Close' : 'Add'}</span>
        </button>
      </div>

      {/* Add Reference Card (Toggle) */}
      {isUploadCardOpen && (
        <div className="ref-upload-card">
          <h3>
            <Upload size={18} style={{ color: '#818cf8' }} />
            <span>Register New Reference</span>
          </h3>
          <div className="ref-upload-grid">
            <div className="ref-upload-field">
              <label htmlFor="reference-role">Source Category</label>
              <select id="reference-role" value={role} onChange={event => setRole(event.target.value as ReferenceRole)}>
                {Object.entries(referenceRoleLabel).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>
            <div className="ref-upload-field">
              <label htmlFor="reference-file">Select File (Markdown, TXT, PDF)</label>
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
            • Markdown/TXT files are supported up to 2 MB; PDF files up to 20 MB / 300 pages.<br />
            • All registered sources are unified into the LLM Wiki library with integrity preserved.
          </p>
        </div>
      )}

      {/* PDF Extraction Status Card (only shown while processing, incomplete, or unlinked) */}
      {!!pendingOrIssuePdfs.length && (
        <section aria-label="PDF Processing Status" style={{ marginBottom: '20px' }}>
          <h4 style={{ fontSize: '0.9rem', color: '#cbd5e1', marginBottom: '10px' }}>PDF Processing & Extraction Status</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {pendingOrIssuePdfs.map(asset => (
              <div key={asset.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.03)', padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.06)' }}>
                <span style={{ fontSize: '0.85rem', color: '#e2e8f0' }}>
                  <strong>{asset.name}</strong> · {pdfStatusLabel[asset.status]} ({asset.completedPages}/{asset.pageCount || '?'} pages)
                </span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button type="button" className="ref-action-btn" disabled={busy} onClick={() => setOriginal({ id: asset.id, name: asset.name })}>
                    <Eye size={13} /> View Original PDF
                  </button>
                  {['pending', 'running', 'cancelled', 'failed'].includes(asset.status) && (
                    <button type="button" className="ref-action-btn" disabled={busy} onClick={() => {
                      setBusy(true);
                      void continuePdf(asset.id).catch(cause => setError(String(cause))).finally(() => setBusy(false));
                    }}>
                      Resume Extraction
                    </button>
                  )}
                  {!sources.some(source => source.pdf?.assetId === asset.id) && (
                    <button type="button" className="ref-action-btn delete" disabled={busy || pdfProcessing || !canDelete || asset.status === 'running'} onClick={() => void removeUnlinkedPdf(asset)}>
                      Delete PDF
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Main Reference Catalog List (Card Style) */}
      <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: '#f1f5f9', marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Registered Project References ({sources.length})</span>
      </h3>

      {sources.length === 0 ? (
        <div className="ref-empty-box">
          <Folder size={36} style={{ color: '#64748b', opacity: 0.6 }} />
          <h4>No Registered References</h4>
          <p>Register papers (PDF), Markdown notes, or web documents to use in your research.</p>
          <button
            type="button"
            className="ref-add-toggle-btn"
            onClick={() => setIsUploadCardOpen(true)}
          >
            <Plus size={16} /> Add
          </button>
        </div>
      ) : (
        <div className="ref-card-list">
          {sources.map(source => {
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
                      <span>Added: {new Date(source.createdAt).toLocaleDateString('en-US')}</span>
                      <span>•</span>
                      <span>SHA: <code className="ref-card-hash">{source.contentHash.slice(0, 10)}</code></span>
                      {source.pdf && (
                        <>
                          <span>•</span>
                          <span>PDF {source.pdf.pageCount} pages</span>
                          {source.pdf.pages.some(p => p.status === 'empty') && (
                            <span style={{ color: '#f87171' }}>
                              ({source.pdf.pages.filter(p => p.status === 'empty').length} pages without text)
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
                      <Eye size={13} /> View Original
                    </button>
                  )}
                  <button
                    type="button"
                    className="ref-action-btn delete"
                    disabled={!canDelete}
                    aria-label={`Delete registered reference: ${source.name}`}
                    onClick={() => void removeSource(source)}
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {original && (
        <Suspense fallback={<p role="status">Loading PDF viewer…</p>}>
          <PdfOriginal {...original} onClose={() => setOriginal(null)} />
        </Suspense>
      )}
    </dialog>
  );
}
