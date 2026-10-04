import React, { useState, useEffect } from 'react';
import { Search, X, Copy, Quote, ArrowRight, Check, FileText, Database } from 'lucide-react';
import type { RetrievalHit } from '../services/retrieval/types';
import type { DocumentVersion } from '../services/theory/types';
import { qaxiomDatabase } from '../services/database';
import { loadReferenceSelection } from '../services/retrieval/references';
import { searchBM25 } from '../services/retrieval/bm25';
import { resolveSourceIdsFromWikiIds } from '../services/wiki/wikiService';
import { spanLocation } from '../services/retrieval/pdfTypes';
import './NoteReferences.css';

interface NoteTextHit {
  id: string;
  lineNumber: number;
  lineContent: string;
}

interface NoteInlineSearchDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  version?: DocumentVersion;
  markdown?: string;
  onInsertQuote: (quote: string, sourceName: string, locationStr: string) => void;
  onSendToChat?: (query: string, hit: RetrievalHit) => void;
  onSelectNoteLine?: (lineNumber: number) => void;
}

export const NoteInlineSearchDrawer: React.FC<NoteInlineSearchDrawerProps> = ({
  isOpen,
  onClose,
  version,
  markdown = '',
  onInsertQuote,
  onSendToChat,
  onSelectNoteLine
}) => {
  const [mainTab, setMainTab] = useState<'note_text' | 'rag_reference'>('note_text');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'bound' | 'all'>('bound');
  const [hits, setHits] = useState<RetrievalHit[]>([]);
  const [noteHits, setNoteHits] = useState<NoteTextHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [insertedId, setInsertedId] = useState<string | null>(null);

  // Real-time note text search when query or mainTab changes
  useEffect(() => {
    if (mainTab !== 'note_text' || !query.trim() || !markdown) {
      if (mainTab === 'note_text') setNoteHits([]);
      return;
    }

    const lines = markdown.split('\n');
    const results: NoteTextHit[] = [];
    const qLower = query.toLowerCase();

    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes(qLower)) {
        results.push({
          id: `line-${idx + 1}`,
          lineNumber: idx + 1,
          lineContent: line.trim()
        });
      }
    });

    setNoteHits(results);
    setStatus(results.length > 0 ? `노트 내 ${results.length}개 구절 발견` : '일치하는 단어가 없습니다.');
  }, [query, markdown, mainTab]);

  const handleSearch = async () => {
    if (!query.trim()) return;
    if (mainTab === 'note_text') return;

    setBusy(true);
    setError('');
    setStatus('레퍼런스 RAG 검색 중…');
    setHits([]);

    try {
      let targetSourceIds: string[] = [];

      if (scope === 'bound') {
        const boundIds = version?.referenceIds ?? [];
        if (boundIds.length === 0) {
          setBusy(false);
          setStatus('이 노트에 연결된 레퍼런스가 없습니다. [+ 레퍼런스 추가]로 연결하거나 [전체 Wiki 서고] 선택 후 검색하세요.');
          return;
        }
        targetSourceIds = await resolveSourceIdsFromWikiIds(boundIds);
        if (targetSourceIds.length === 0) {
          targetSourceIds = boundIds;
        }
      } else {
        const allRefs = await qaxiomDatabase.references.toArray();
        targetSourceIds = allRefs.map(r => r.id);
      }

      if (targetSourceIds.length === 0) {
        setBusy(false);
        setStatus('프로젝트에 검색 가능한 레퍼런스 자료가 없습니다. [Project References]에서 자료를 추가하세요.');
        return;
      }

      const data = await loadReferenceSelection(targetSourceIds);

      if (!data.referenceSpans || data.referenceSpans.length === 0) {
        setBusy(false);
        setStatus('선택한 레퍼런스에 인덱싱된 구절이 없습니다.');
        return;
      }

      // Execute BM25 RAG search
      const results = searchBM25(data, query);
      setHits(results);
      setBusy(false);
      setStatus(results.length > 0 ? `검색 결과 ${results.length}건 발견` : '일치하는 구절이 없습니다. 다른 키워드(용어, 수식, 개념)로 검색해 보세요.');
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : '검색 실패');
    }
  };

  // Auto trigger RAG search when switching scope or mainTab
  useEffect(() => {
    if (mainTab === 'rag_reference' && query.trim()) {
      void handleSearch();
    }
  }, [mainTab, scope]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      void handleSearch();
    }
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleInsert = (hit: RetrievalHit) => {
    const loc = spanLocation(hit.span);
    onInsertQuote(hit.span.text, hit.source.name, loc);
    setInsertedId(hit.span.id);
    setTimeout(() => setInsertedId(null), 1500);
  };

  const boundCount = version?.referenceIds?.length ?? 0;

  if (!isOpen) return null;

  return (
    <div className="note-inline-search-drawer" aria-label="통합 에디터 검색">
      {/* Drawer Header */}
      <div className="drawer-header">
        <div className="drawer-title">
          <Search size={16} />
          <span>통합 검색</span>
        </div>
        <button type="button" className="drawer-close-btn" onClick={onClose} aria-label="닫기">
          <X size={16} />
        </button>
      </div>

      {/* Top Main Tabs */}
      <div className="drawer-main-tabs">
        <button
          type="button"
          className={`drawer-tab-btn ${mainTab === 'note_text' ? 'active' : ''}`}
          onClick={() => {
            setMainTab('note_text');
            setStatus('');
          }}
        >
          <FileText size={13} />
          <span>노트 내 단어 찾기</span>
        </button>
        <button
          type="button"
          className={`drawer-tab-btn ${mainTab === 'rag_reference' ? 'active' : ''}`}
          onClick={() => {
            setMainTab('rag_reference');
            setStatus('');
          }}
        >
          <Database size={13} />
          <span>레퍼런스 RAG 검색</span>
        </button>
      </div>

      {/* Scope Selector for RAG tab */}
      {mainTab === 'rag_reference' && (
        <div className="drawer-scope-selector">
          <label className={`scope-pill ${scope === 'bound' ? 'active' : ''}`}>
            <input
              type="radio"
              name="search-scope"
              checked={scope === 'bound'}
              onChange={() => setScope('bound')}
            />
            <span>이 노트 레퍼런스만 ({boundCount}개)</span>
          </label>
          <label className={`scope-pill ${scope === 'all' ? 'active' : ''}`}>
            <input
              type="radio"
              name="search-scope"
              checked={scope === 'all'}
              onChange={() => setScope('all')}
            />
            <span>전체 Wiki 서고</span>
          </label>
        </div>
      )}

      {/* Search Bar */}
      <div className="drawer-search-bar">
        <input
          type="text"
          placeholder={mainTab === 'note_text' ? '노트 본문 단어/문장 검색…' : '레퍼런스 수식, 용어, 키워드 검색 (Enter)…'}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        {mainTab === 'rag_reference' && (
          <button type="button" className="search-exec-btn" onClick={handleSearch} disabled={busy || !query.trim()}>
            {busy ? '검색 중…' : '검색'}
          </button>
        )}
      </div>

      {/* Status & Error */}
      {status && <div className="drawer-status">{status}</div>}
      {error && <div className="drawer-error">{error}</div>}

      {/* Results List */}
      <div className="drawer-results-list">
        {mainTab === 'note_text' ? (
          noteHits.map(hit => (
            <div
              key={hit.id}
              className="search-hit-card note-hit-card clickable"
              onClick={() => onSelectNoteLine?.(hit.lineNumber)}
              title="클릭 시 에디터의 해당 라인 위치로 즉시 이동"
            >
              <div className="hit-meta-row">
                <span className="hit-location-tag">📍 Line {hit.lineNumber}</span>
                <span className="hit-goto-hint">위치로 이동 ➔</span>
              </div>
              <div className="hit-excerpt">
                <pre>{hit.lineContent}</pre>
              </div>
            </div>
          ))
        ) : (
          hits.map(hit => {
            const loc = spanLocation(hit.span);
            return (
              <div key={hit.span.id} className="search-hit-card">
                <div className="hit-meta-row">
                  <span className="hit-source-name" title={hit.source.name}>
                    {hit.source.name}
                  </span>
                  <span className="hit-location">{loc}</span>
                  <span className="hit-score">점수 {hit.score.toFixed(2)}</span>
                </div>

                <div className="hit-excerpt">
                  <pre>{hit.span.text}</pre>
                </div>

                <div className="hit-actions-row">
                  <button
                    type="button"
                    className="hit-action-btn insert-btn"
                    onClick={() => handleInsert(hit)}
                    title="현재 커서 위치에 마크다운 인용문 삽입"
                  >
                    {insertedId === hit.span.id ? <Check size={12} /> : <Quote size={12} />}
                    <span>{insertedId === hit.span.id ? '본문 삽입됨!' : '본문에 인용 삽입'}</span>
                  </button>

                  <button
                    type="button"
                    className="hit-action-btn copy-btn"
                    onClick={() => handleCopy(hit.span.text, hit.span.id)}
                    title="발췌문 복사"
                  >
                    {copiedId === hit.span.id ? <Check size={12} /> : <Copy size={12} />}
                    <span>{copiedId === hit.span.id ? '복사됨' : '복사'}</span>
                  </button>

                  {onSendToChat && (
                    <button
                      type="button"
                      className="hit-action-btn chat-btn"
                      onClick={() => onSendToChat(query, hit)}
                      title="이 구절을 대화창으로 전달"
                    >
                      <ArrowRight size={12} />
                      <span>대화창 질문</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default NoteInlineSearchDrawer;
