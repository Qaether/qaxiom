import React, { useState, useRef } from 'react';
import { Download, Edit3, Check, Plus, History } from 'lucide-react';
import type { ChatSession, ResearchMode } from '../types';
import { RESEARCH_MODES } from '../constants';
import { sessionToMarkdown } from '../services/workspace';

interface ChatPanelHeaderProps {
  currentSession: ChatSession;
  onUpdateTitle: (newTitle: string) => void;
  onNewSession: () => void;
  currentMode: ResearchMode;
  onModeChange: (mode: ResearchMode) => void;
  isHistoryOpen?: boolean;
  onToggleHistory?: () => void;
}

export const ChatPanelHeader: React.FC<ChatPanelHeaderProps> = ({
  currentSession,
  onUpdateTitle,
  onNewSession,
  currentMode,
  onModeChange,
  isHistoryOpen = false,
  onToggleHistory
}) => {
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState(currentSession.title);
  const titleButtonRef = useRef<HTMLButtonElement>(null);

  const finishTitleEditing = () => {
    setIsEditingTitle(false);
    requestAnimationFrame(() => titleButtonRef.current?.focus());
  };

  const handleTitleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (titleInput.trim()) {
      onUpdateTitle(titleInput.trim());
    }
    finishTitleEditing();
  };

  const handleExportMarkdown = () => {
    if (!currentSession.messages.length) return;
    const blob = new Blob([sessionToMarkdown(currentSession)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentSession.title.replace(/[^a-zA-Z0-9가-힣_-]/g, '_')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="chat-panel-header">
      <div className="chat-panel-header-left">
        {/* Mode Selector */}
        <div className="chat-panel-mode-wrapper">
          <label htmlFor="chat-panel-mode-select" className="chat-panel-mode-label">모드</label>
          <select
            id="chat-panel-mode-select"
            className="chat-panel-mode-select"
            aria-label="연구 모드 선택"
            value={currentMode}
            onChange={e => onModeChange(e.target.value as ResearchMode)}
          >
            {Object.entries(RESEARCH_MODES).map(([key, mode]) => (
              <option key={key} value={key}>
                {mode.name}
              </option>
            ))}
          </select>
        </div>

        <h2 className="sr-only" aria-label={currentSession.title || '새로운 연구 대화'}>
          {currentSession.title || '새로운 연구 대화'}
        </h2>

        {isEditingTitle && (
          <form onSubmit={handleTitleSubmit} className="title-edit-form chat-title-edit-form">
            <input
              type="text"
              className="title-edit-input"
              aria-label="대화 제목 입력"
              value={titleInput}
              onChange={e => setTitleInput(e.target.value)}
              autoFocus
              onBlur={event => {
                if (!event.currentTarget.form?.contains(event.relatedTarget as Node | null)) setIsEditingTitle(false);
              }}
              onKeyDown={event => {
                if (event.key === 'Escape') finishTitleEditing();
              }}
            />
            <button type="submit" className="title-save-btn topbar-tooltip" data-tooltip="대화 제목 저장" aria-label="대화 제목 저장">
              <Check size={14} />
            </button>
          </form>
        )}
      </div>

      <div className="chat-panel-header-right">
        {!isEditingTitle && (
          <button
            ref={titleButtonRef}
            type="button"
            className="title-edit-btn chat-title-toggle-btn topbar-tooltip"
            onClick={() => { setTitleInput(currentSession.title); setIsEditingTitle(true); }}
            data-tooltip="제목 변경"
            aria-label={`${currentSession.title || '새로운 연구 대화'} 제목 수정`}
          >
            <Edit3 size={16} aria-hidden="true" />
          </button>
        )}

        {/* Chat History Toggle Button (Rotate Arrow) */}
        {onToggleHistory && (
          <button
            type="button"
            className={`chat-panel-action-btn chat-history-toggle-btn topbar-tooltip ${isHistoryOpen ? 'active' : ''}`}
            onClick={onToggleHistory}
            data-tooltip="대화 기록"
            aria-label="대화 기록 보기"
            aria-expanded={isHistoryOpen}
          >
            <History size={16} />
          </button>
        )}

        {/* Export Markdown Button */}
        <button
          type="button"
          className="chat-panel-action-btn chat-export-btn topbar-tooltip"
          onClick={handleExportMarkdown}
          data-tooltip="대화 내보내기"
          aria-label="대화 내용 Markdown 내보내기"
          disabled={currentSession.messages.length === 0}
        >
          <Download size={16} />
        </button>

        {/* New Session Button */}
        <button
          type="button"
          className="chat-panel-action-btn chat-panel-new-chat-btn topbar-tooltip"
          onClick={onNewSession}
          data-tooltip="새 대화"
          aria-label="새 대화 시작"
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
};
