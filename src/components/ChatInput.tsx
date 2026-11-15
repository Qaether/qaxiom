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
  const isComposingRef = useRef(false);

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
    const currentVal = textareaRef.current?.value ?? input;
    const trimmed = currentVal.trim();
    if (!trimmed) return;
    onSendMessage(trimmed);
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.value = '';
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    isComposingRef.current = false;
    setInput(e.currentTarget.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || isComposingRef.current) {
      return;
    }
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
            aria-label="Enter research question"
            value={input}
            onChange={e => setInput(e.target.value)}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            onKeyDown={handleKeyDown}
            placeholder={
              currentMode === 'peer_review'
                ? "Enter your research idea, abstract, or hypothesis for peer review..."
                : currentMode === 'math_proof'
                ? "Enter equations or theoretical assumptions to prove or derive..."
                : currentMode === 'proofreader'
                ? "Enter academic text to proofread..."
                : "Enter a research topic, paper question, or hypothesis to analyze (Shift+Enter for new line)..."
            }
            rows={1}
            disabled={isStreaming}
          />

          <button
            type="submit"
            id="send-message-btn"
            className={`send-button ${isStreaming ? 'stop-state' : ''}`}
            disabled={!isStreaming && !input.trim()}
            title={isStreaming ? "Stop generation" : "Send (Enter)"}
            aria-label={isStreaming ? "Stop generation" : "Send message"}
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
                aria-label="Select chat model"
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
                      {m.name} {m.status === 'preview' ? '[Preview]' : ''} {mHasKey ? '✓' : '(Key required)'}
                    </option>
                  );
                })}
              </select>
            </div>
            <span className={`compact-model-badge ${hasKey ? 'active' : 'need-key'}`}>
              {hasKey ? 'Key configured' : 'Key required'}
            </span>
          </div>
        )}
      </form>
    </div>
  );
};
