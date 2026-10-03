import React, { useState, useRef } from 'react';
import { Download, Edit3, Check, Plus } from 'lucide-react';
import type { ChatSession, ResearchMode } from '../types';
import { RESEARCH_MODES } from '../constants';
import { sessionToMarkdown } from '../services/workspace';

interface ChatPanelHeaderProps {
  currentSession: ChatSession;
  onUpdateTitle: (newTitle: string) => void;
  onNewSession: () => void;
  currentMode: ResearchMode;
  onModeChange: (mode: ResearchMode) => void;
}

export const ChatPanelHeader: React.FC<ChatPanelHeaderProps> = ({
  currentSession,
  onUpdateTitle,
  onNewSession,
  currentMode,
  onModeChange
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
        {isEditingTitle ? (
          <form onSubmit={handleTitleSubmit} className="title-edit-form">
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
            <button type="submit" className="title-save-btn" aria-label="대화 제목 저장">
              <Check size={14} />
            </button>
          </form>
        ) : (
          <div className="title-display">
            <h2 aria-label={currentSession.title || '새로운 연구 대화'}>
              <button
                ref={titleButtonRef}
                type="button"
                className="title-edit-btn"
                onClick={() => { setTitleInput(currentSession.title); setIsEditingTitle(true); }}
                aria-label={`${currentSession.title || '새로운 연구 대화'} 제목 수정`}
              >
                <span>{currentSession.title || '새로운 연구 대화'}</span>
                <Edit3 size={13} className="edit-icon" />
              </button>
            </h2>
          </div>
        )}

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
      </div>

      <div className="chat-panel-header-right">
        {/* Export Markdown Button */}
        <button
          className="header-btn chat-export-btn"
          onClick={handleExportMarkdown}
          title="내보내기"
          aria-label="내보내기"
          disabled={currentSession.messages.length === 0}
        >
          <Download size={15} />
        </button>

        {/* New Session Button */}
        <button
          type="button"
          className="chat-panel-new-chat-btn"
          onClick={onNewSession}
          title="새 연구 대화 시작"
          aria-label="새 연구 세션 시작"
        >
          <Plus size={15} />
        </button>
      </div>
    </div>
  );
};
