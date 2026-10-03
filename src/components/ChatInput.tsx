import React, { useState, useRef, useEffect } from 'react';
import { Send, Square, Bot } from 'lucide-react';
import type { ResearchMode } from '../types';
import { AVAILABLE_MODELS } from '../constants';

interface ChatInputProps {
  onSendMessage: (content: string) => void;
  isStreaming: boolean;
  onStopStreaming: () => void;
  currentMode: ResearchMode;
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
  apiKeys?: Record<string, string>;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  onSendMessage,
  isStreaming,
  onStopStreaming,
  currentMode,
  selectedModel,
  onModelChange,
  apiKeys
}) => {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isStreaming) {
      onStopStreaming();
      return;
    }
    const trimmed = input.trim();
    if (!trimmed) return;
    onSendMessage(trimmed);
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const activeModelObj = AVAILABLE_MODELS.find(m => m.id === selectedModel);
  const hasKey = activeModelObj && apiKeys && Boolean((apiKeys[activeModelObj.provider] || '').trim());

  return (
    <div className="chat-input-container">
      {/* Input Box */}
      <form onSubmit={handleSubmit} className="input-form">
        <div className="input-wrapper">
          <textarea
            ref={textareaRef}
            id="chat-textarea"
            aria-label="연구 질문 입력"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              currentMode === 'peer_review'
                ? "피어 리뷰를 받고 싶은 연구 아이디어, 초록, 가설을 입력하세요..."
                : currentMode === 'math_proof'
                ? "증명이나 유도가 필요한 수식 또는 이론적 가정을 입력하세요..."
                : currentMode === 'proofreader'
                ? "교정할 영문 문장 또는 한글 학술 텍스트를 입력하세요..."
                : "연구 주제, 논문 질문, 또는 분석할 가설을 입력하세요 (Shift+Enter로 줄바꿈)..."
            }
            rows={1}
            disabled={isStreaming}
          />

          <button
            type="submit"
            id="send-message-btn"
            className={`send-button ${isStreaming ? 'stop-state' : ''}`}
            disabled={!isStreaming && !input.trim()}
            title={isStreaming ? "생성 중단" : "전송 (Enter)"}
            aria-label={isStreaming ? "생성 중단" : "메시지 전송"}
          >
            {isStreaming ? <Square size={16} /> : <Send size={16} />}
          </button>
        </div>

        {/* Compact LLM Model Selector under input box */}
        {selectedModel && onModelChange && (
          <div className="chat-model-bar">
            <div className="compact-model-selector-wrapper">
              <Bot size={13} className="compact-model-icon" />
              <select
                id="header-model-select"
                className="compact-model-select"
                aria-label="대화 모델 선택"
                value={selectedModel}
                onChange={e => onModelChange(e.target.value)}
                onKeyDown={event => {
                  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const index = AVAILABLE_MODELS.findIndex(model => model.id === selectedModel);
                  const nextIndex = event.key === 'Home' ? 0
                    : event.key === 'End' ? AVAILABLE_MODELS.length - 1
                    : Math.max(0, Math.min(AVAILABLE_MODELS.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
                  onModelChange(AVAILABLE_MODELS[nextIndex].id);
                }}
              >
                {AVAILABLE_MODELS.map(m => {
                  const mHasKey = apiKeys && Boolean((apiKeys[m.provider] || '').trim());
                  return (
                    <option key={m.id} value={m.id}>
                      {m.name} {m.status === 'preview' ? '[Preview]' : ''} {mHasKey ? '✓' : '(키 필요)'}
                    </option>
                  );
                })}
              </select>
            </div>
            <span className={`compact-model-badge ${hasKey ? 'active' : 'need-key'}`}>
              {hasKey ? '키 등록됨' : '키 필요'}
            </span>
          </div>
        )}
      </form>
    </div>
  );
};
