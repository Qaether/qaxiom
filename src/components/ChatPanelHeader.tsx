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
    a.download = `${currentSession.title.replace(/[^a-zA-Z0-9\uAC00-\uD7A3_-]/g, '_')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="chat-panel-header">
      <div className="chat-panel-header-left">
        {/* Mode Selector */}
        <div className="chat-panel-mode-wrapper">
          <label htmlFor="chat-panel-mode-select" className="chat-panel-mode-label">Mode</label>
          <select
            id="chat-panel-mode-select"
            className="chat-panel-mode-select"
            aria-label="Select research mode"
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

        <h2 className="sr-only" aria-label={currentSession.title || 'New research chat'}>
          {currentSession.title || 'New research chat'}
        </h2>

        {isEditingTitle && (
          <form onSubmit={handleTitleSubmit} className="title-edit-form chat-title-edit-form">
            <input
              type="text"
              className="title-edit-input"
              aria-label="Enter chat title"
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
            <button type="submit" className="title-save-btn topbar-tooltip" data-tooltip="Save chat title" aria-label="Save chat title">
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
            data-tooltip="Rename"
            aria-label={`Rename ${currentSession.title || 'New research chat'}`}
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
            data-tooltip="Chat history"
            aria-label="View chat history"
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
          data-tooltip="Export chat"
          aria-label="Export chat as Markdown"
          disabled={currentSession.messages.length === 0}
        >
          <Download size={16} />
        </button>

        {/* New Session Button */}
        <button
          type="button"
          className="chat-panel-action-btn chat-panel-new-chat-btn topbar-tooltip"
          onClick={onNewSession}
          data-tooltip="New chat"
          aria-label="Start new chat"
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
};
