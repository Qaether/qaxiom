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
      setErrorMessage(err instanceof Error ? err.message : 'Wiki 자료를 불러오지 못했습니다.');
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
      setErrorMessage(err instanceof Error ? err.message : '저장에 실패했습니다.');
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
    setStatusMessage('파일을 등록하고 Wiki에 색인하는 중…');
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
      setStatusMessage(`“${file.name}” 파일이 Wiki에 등록되고 현재 노트에 연결되었습니다.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '파일 처리에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  // Submit Web URL content
  const handleWebSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!webUrl.trim() || !webContent.trim()) {
      setErrorMessage('URL과 웹 문서 본문 내용을 입력해 주세요.');
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
      setStatusMessage('웹 레퍼런스가 등록되어 현재 노트에 연결되었습니다.');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '웹 레퍼런스 등록에 실패했습니다.');
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
      setStatusMessage(`내부 연구 스냅샷 “${ver.title} (v${ver.number})”이 연결되었습니다.`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '연구 스냅샷 연결에 실패했습니다.');
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
        return <span className="entry-tag tag-paper"><FileText size={11} /> 논문/파일</span>;
      case 'web':
        return <span className="entry-tag tag-web"><Globe size={11} /> 웹</span>;
      case 'theory_snapshot':
        return <span className="entry-tag tag-theory"><BookOpen size={11} /> 내부 연구</span>;
      default:
        return <span className="entry-tag tag-note"><FileText size={11} /> 노트</span>;
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
              <h3 id="note-references-title">레퍼런스 추가</h3>
              <p className="modal-subtitle">
                현재 연구노트에 연결할 자료를 선택하세요. 선택된 자료만 이 노트의 RAG 검색 범위에 포함됩니다.
              </p>
            </div>
          </div>
          <button type="button" className="close-btn" onClick={onClose} aria-label="닫기">
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
            Wiki 서고에서 선택 ({selectedIds.length}개 선택됨)
          </button>
          <button
            type="button"
            className={`tab-btn ${activeTab === 'file' ? 'active' : ''}`}
            onClick={() => setActiveTab('file')}
          >
            새 파일 등록
          </button>
          <button
            type="button"
            className={`tab-btn ${activeTab === 'web' ? 'active' : ''}`}
            onClick={() => setActiveTab('web')}
          >
            웹 URL 추가
          </button>
          <button
            type="button"
            className={`tab-btn ${activeTab === 'theories' ? 'active' : ''}`}
            onClick={() => setActiveTab('theories')}
          >
            내 다른 연구노트 가져오기
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
                  placeholder="Wiki 서고 자료 검색..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
              </div>

              {filteredWikiPages.length === 0 ? (
                <div className="empty-wiki-hint">
                  {wikiPages.length === 0 ? (
                    <p>등록된 Wiki 자료가 없습니다. [새 파일 등록] 또는 [웹 URL 추가] 탭에서 자료를 추가해 보세요.</p>
                  ) : (
                    <p>검색 결과와 일치하는 Wiki 자료가 없습니다.</p>
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
                                title="원본 링크 열기"
                              >
                                <ExternalLink size={12} />
                              </a>
                            )}
                          </div>
                          <p className="item-summary">{page.summary || '내용 요약 없음'}</p>
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
                <h4>파일을 선택하여 Wiki 서고에 등록</h4>
                <p>Markdown(.md), 텍스트(.txt), PDF(.pdf) 파일을 로컬에서 안전하게 색인합니다.</p>
                <label className="file-choose-label">
                  파일 선택
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
                <label htmlFor="web-url">참조 웹 URL *</label>
                <input
                  id="web-url"
                  type="url"
                  placeholder="https://arxiv.org/abs/... 또는 웹 문서 링크"
                  value={webUrl}
                  onChange={e => setWebUrl(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="web-title">문서 제목 (선택)</label>
                <input
                  id="web-title"
                  type="text"
                  placeholder="논문명 또는 기사 제목"
                  value={webTitle}
                  onChange={e => setWebTitle(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label htmlFor="web-content">발췌 본문 텍스트 (Markdown/텍스트) *</label>
                <textarea
                  id="web-content"
                  rows={6}
                  placeholder="웹 페이지에서 참고할 본문이나 초록을 복사해 붙여넣으세요..."
                  value={webContent}
                  onChange={e => setWebContent(e.target.value)}
                  required
                />
              </div>
              <button type="submit" className="submit-btn" disabled={busy}>
                <Plus size={14} />
                <span>Wiki에 등록 및 현재 노트에 연결</span>
              </button>
            </form>
          )}

          {activeTab === 'theories' && (
            <div className="tab-pane-theories">
              <p className="theories-intro">
                같은 프로젝트 내의 다른 연구노트 확정 버전을 이 노트의 전제/레퍼런스로 연결합니다.
              </p>
              {otherTheories.length === 0 ? (
                <p className="empty-hint">참조할 수 있는 다른 연구노트가 없습니다.</p>
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
                        <span>이 버전 연결</span>
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
            <span>선택된 레퍼런스: <strong>{selectedIds.length}</strong>개</span>
          </div>
          <div className="footer-actions">
            <button type="button" className="btn-cancel" onClick={onClose} disabled={busy}>
              취소
            </button>
            <button type="button" className="btn-save" onClick={handleSave} disabled={busy}>
              <Check size={14} />
              <span>적용하기</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NoteReferencesModal;
