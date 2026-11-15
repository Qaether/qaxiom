import React, { useState, useEffect } from 'react';
import { BookOpen, FileText, Globe, Plus, Upload, X, Check, Search, ExternalLink } from 'lucide-react';
import type { WikiPage, WikiEntryType } from '../types';
import type { DocumentVersion, TheoryDocument } from '../services/theory/types';
import { listWikiPages, publishTheoryToWiki, importWebToWiki } from '../services/wiki/wikiService';
import { importReferenceFile } from '../services/retrieval/references';
import { registerPdf } from '../services/retrieval/pdfIngestion';
import { listTheories } from '../services/theory/documents';
import './NoteReferences.css';

interface NoteReferencesModalProps {
  isOpen: boolean;
  onClose: () => void;
  documentId: string;
  version: DocumentVersion;
  boundIds: string[];
  onSaveBindings: (newBoundIds: string[]) => Promise<void>;
}

type TabType = 'wiki' | 'file' | 'web' | 'theories';

export const NoteReferencesModal: React.FC<NoteReferencesModalProps> = ({
  isOpen,
  onClose,
  documentId,
  version: _version,
  boundIds,
  onSaveBindings
}) => {
  const [activeTab, setActiveTab] = useState<TabType>('wiki');
  const [wikiPages, setWikiPages] = useState<WikiPage[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>(boundIds);
  const [searchQuery, setSearchQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // Web input state
  const [webUrl, setWebUrl] = useState('');
  const [webTitle, setWebTitle] = useState('');
  const [webContent, setWebContent] = useState('');

  // Other theories state
  const [otherTheories, setOtherTheories] = useState<{ document: TheoryDocument; version: DocumentVersion }[]>([]);

  useEffect(() => {
    setSelectedIds(boundIds);
  }, [boundIds]);

  const loadData = async () => {
    setBusy(true);
    try {
      const pages = await listWikiPages();
      setWikiPages(pages);
      const allTheories = await listTheories();
      setOtherTheories(allTheories.filter(t => t.document.id !== documentId));
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load Wiki resources.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void loadData();
      setStatusMessage('');
      setErrorMessage('');
    }
  }, [isOpen, documentId]);

  if (!isOpen) return null;

  const handleToggleSelect = (pageId: string) => {
    setSelectedIds(prev =>
      prev.includes(pageId) ? prev.filter(id => id !== pageId) : [...prev, pageId]
    );
  };

  const handleSave = async () => {
    setBusy(true);
    try {
      await onSaveBindings(selectedIds);
      onClose();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setBusy(false);
    }
  };

  // Upload local file (PDF / MD / TXT)
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setBusy(true);
    setErrorMessage('');
    setStatusMessage('Registering file and indexing into Wiki…');
    try {
      if (file.name.toLowerCase().endsWith('.pdf')) {
        const result = await registerPdf(file.name, await file.arrayBuffer(), 'external');
        const wikiId = `wiki-ref-pdf-${result.asset.id}`;
        setSelectedIds(prev => [...new Set([...prev, wikiId])]);
      } else {
        const result = await importReferenceFile(file, 'external');
        const wikiId = `wiki-ref-${result.source.id}`;
        setSelectedIds(prev => [...new Set([...prev, wikiId])]);
      }
      await loadData();
      setStatusMessage(`"${file.name}" has been registered to Wiki and linked to the current note.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to process file.');
    } finally {
      setBusy(false);
    }
  };

  // Submit Web URL content
  const handleWebSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!webUrl.trim() || !webContent.trim()) {
      setErrorMessage('Please enter both the URL and web document content.');
      return;
    }
    setBusy(true);
    setErrorMessage('');
    try {
      const page = await importWebToWiki(webUrl, webTitle, webContent);
      setSelectedIds(prev => [...new Set([...prev, page.id])]);
      setWebUrl('');
      setWebTitle('');
      setWebContent('');
      await loadData();
      setActiveTab('wiki');
      setStatusMessage('Web reference registered and linked to the current note.');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to register web reference.');
    } finally {
      setBusy(false);
    }
  };

  // Import other theory version snapshot
  const handleImportTheory = async (doc: TheoryDocument, ver: DocumentVersion) => {
    setBusy(true);
    setErrorMessage('');
    try {
      const page = await publishTheoryToWiki(doc, ver);
      setSelectedIds(prev => [...new Set([...prev, page.id])]);
      await loadData();
      setStatusMessage(`Internal research snapshot "${ver.title} (v${ver.number})" linked.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to link research snapshot.');
    } finally {
      setBusy(false);
    }
  };

  const filteredWikiPages = wikiPages.filter(p =>
    p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.summary.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getEntryBadge = (type?: WikiEntryType) => {
    switch (type) {
      case 'paper':
        return <span className="entry-tag tag-paper"><FileText size={11} /> Paper / File</span>;
      case 'web':
        return <span className="entry-tag tag-web"><Globe size={11} /> Web</span>;
      case 'theory_snapshot':
        return <span className="entry-tag tag-theory"><BookOpen size={11} /> Internal Research</span>;
      default:
        return <span className="entry-tag tag-note"><FileText size={11} /> Note</span>;
    }
  };

  return (
    <div className="note-references-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="note-references-title">
      <div className="note-references-modal-card" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <div className="modal-header-left">
            <BookOpen className="header-icon" size={20} />
            <div>
              <h3 id="note-references-title">Add References</h3>
              <p className="modal-subtitle">
                Select sources to link to this research note. Only selected sources are included in this note’s RAG search scope.
              </p>
            </div>
          </div>
          <button type="button" className="close-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="modal-tabs">
          <button
            type="button"
            className={`tab-btn ${activeTab === 'wiki' ? 'active' : ''}`}
            onClick={() => setActiveTab('wiki')}
          >
            Select from Wiki ({selectedIds.length} selected)
          </button>
          <button
            type="button"
            className={`tab-btn ${activeTab === 'file' ? 'active' : ''}`}
            onClick={() => setActiveTab('file')}
          >
            Upload File
          </button>
          <button
            type="button"
            className={`tab-btn ${activeTab === 'web' ? 'active' : ''}`}
            onClick={() => setActiveTab('web')}
          >
            Add Web URL
          </button>
          <button
            type="button"
            className={`tab-btn ${activeTab === 'theories' ? 'active' : ''}`}
            onClick={() => setActiveTab('theories')}
          >
            Import Research Note
          </button>
        </div>

        {/* Messages */}
        {statusMessage && <div className="modal-alert-status">{statusMessage}</div>}
        {errorMessage && <div className="modal-alert-error">{errorMessage}</div>}

        {/* Content Area */}
        <div className="modal-body">
          {activeTab === 'wiki' && (
            <div className="tab-pane-wiki">
              <div className="search-box">
                <Search size={14} className="search-icon" />
                <input
                  type="text"
                  placeholder="Search Wiki library..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
              </div>

              {filteredWikiPages.length === 0 ? (
                <div className="empty-wiki-hint">
                  {wikiPages.length === 0 ? (
                    <p>No Wiki resources registered. Add one from the [Upload File] or [Add Web URL] tab.</p>
                  ) : (
                    <p>No Wiki resources match your search.</p>
                  )}
                </div>
              ) : (
                <div className="wiki-items-list">
                  {filteredWikiPages.map(page => {
                    const isSelected = selectedIds.includes(page.id) ||
                      (page.sourceId && selectedIds.includes(page.sourceId)) ||
                      (page.versionId && selectedIds.includes(page.versionId));
                    return (
                      <div
                        key={page.id}
                        className={`wiki-item-row ${isSelected ? 'selected' : ''}`}
                        onClick={() => handleToggleSelect(page.id)}
                      >
                        <div className="item-checkbox">
                          <input
                            type="checkbox"
                            checked={Boolean(isSelected)}
                            onChange={() => handleToggleSelect(page.id)}
                            onClick={e => e.stopPropagation()}
                          />
                        </div>
                        <div className="item-details">
                          <div className="item-title-row">
                            <span className="item-title">{page.title}</span>
                            {getEntryBadge(page.entryType)}
                            {page.url && (
                              <a
                                href={page.url}
                                target="_blank"
                                rel="noreferrer"
                                className="item-link"
                                onClick={e => e.stopPropagation()}
                                title="Open original link"
                              >
                                <ExternalLink size={12} />
                              </a>
                            )}
                          </div>
                          <p className="item-summary">{page.summary || 'No summary available'}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === 'file' && (
            <div className="tab-pane-file">
              <div className="file-drop-area">
                <Upload size={32} className="upload-icon" />
                <h4>Select a File to Register in Wiki</h4>
                <p>Markdown (.md), text (.txt), and PDF (.pdf) files are indexed safely on your local device.</p>
                <label className="file-choose-label">
                  Choose File
                  <input
                    type="file"
                    accept=".md,.markdown,.txt,.pdf"
                    onChange={handleFileUpload}
                    style={{ display: 'none' }}
                    disabled={busy}
                  />
                </label>
              </div>
            </div>
          )}

          {activeTab === 'web' && (
            <form className="tab-pane-web" onSubmit={handleWebSubmit}>
              <div className="form-group">
                <label htmlFor="web-url">Reference Web URL *</label>
                <input
                  id="web-url"
                  type="url"
                  placeholder="https://arxiv.org/abs/... or web document URL"
                  value={webUrl}
                  onChange={e => setWebUrl(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="web-title">Document Title (Optional)</label>
                <input
                  id="web-title"
                  type="text"
                  placeholder="Paper or article title"
                  value={webTitle}
                  onChange={e => setWebTitle(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label htmlFor="web-content">Excerpt Body Text (Markdown/Text) *</label>
                <textarea
                  id="web-content"
                  rows={6}
                  placeholder="Paste the relevant excerpt or abstract from the web page..."
                  value={webContent}
                  onChange={e => setWebContent(e.target.value)}
                  required
                />
              </div>
              <button type="submit" className="submit-btn" disabled={busy}>
                <Plus size={14} />
                <span>Register to Wiki & Link to Current Note</span>
              </button>
            </form>
          )}

          {activeTab === 'theories' && (
            <div className="tab-pane-theories">
              <p className="theories-intro">
                Link a finalized version of another research note in the same project as a premise or reference for this note.
              </p>
              {otherTheories.length === 0 ? (
                <p className="empty-hint">No other research notes available to reference.</p>
              ) : (
                <div className="theories-list">
                  {otherTheories.map(t => (
                    <div key={t.document.id} className="theory-item-card">
                      <div className="theory-item-info">
                        <h5>{t.version.title} (v{t.version.number})</h5>
                        <p>{t.version.contract.purpose || t.version.markdown.slice(0, 120)}</p>
                      </div>
                      <button
                        type="button"
                        className="import-theory-btn"
                        onClick={() => handleImportTheory(t.document, t.version)}
                        disabled={busy}
                      >
                        <Plus size={13} />
                        <span>Link Version</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <div className="footer-status">
            <span>Selected references: <strong>{selectedIds.length}</strong></span>
          </div>
          <div className="footer-actions">
            <button type="button" className="btn-cancel" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn-save" onClick={handleSave} disabled={busy}>
              <Check size={14} />
              <span>Apply</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NoteReferencesModal;
