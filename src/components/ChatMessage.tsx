import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { AlertTriangle, BookOpen, Check, CircleStop, Copy, RotateCcw, Sparkles, User } from 'lucide-react';
import type { ChatMessage as ChatMessageType } from '../types';
import { RESEARCH_MODES } from '../constants';
import type { ContextEvidence } from '../services/retrieval/types';
import { inspectCitations } from '../services/retrieval/context';
import { spanLocation } from '../services/retrieval/pdfTypes';
import './References.css';
import 'katex/dist/katex.min.css';

interface ChatMessageProps {
  message: ChatMessageType;
  onRetry?: () => void;
  onOpenSource?: (evidence: ContextEvidence) => void;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ message, onRetry, onOpenSource }) => {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const modeBadge = message.researchMode && RESEARCH_MODES[message.researchMode]?.badge;
  const citations = message.contextBundle ? inspectCitations(message.content, message.contextBundle) : null;

  return (
    <div className={`message-row ${isUser ? 'user-message-row' : 'assistant-message-row'}`}>
      <div className="message-container">
        {/* Avatar */}
        <div className={`message-avatar ${isUser ? 'user-avatar' : 'assistant-avatar'}`}>
          {isUser ? <User size={18} /> : <Sparkles size={18} />}
        </div>

        {/* Bubble */}
        <div className="message-body">
          {/* Header for assistant message */}
          {!isUser && (
            <div className="message-meta">
              <span className="model-badge">{message.model || 'Qaxiom Engine'}</span>
              {modeBadge && <span className="mode-badge">{modeBadge}</span>}
              <button 
                id={`copy-btn-${message.id}`}
                className="copy-btn" 
                onClick={handleCopy} 
                title="답변 복사"
              >
                {copied ? <Check size={14} className="copied-icon" /> : <Copy size={14} />}
                <span>{copied ? '복사됨' : '복사'}</span>
              </button>
            </div>
          )}

          {/* Content */}
          <div className="markdown-content">
            <ReactMarkdown
              remarkPlugins={[remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                code({ node: _node, inline, className, children, ...props }: any) {
                  const match = /language-(\w+)/.exec(className || '');
                  const isBibtex = match && match[1] === 'bibtex';
                  const codeString = String(children).replace(/\n$/, '');

                  if (!inline && match) {
                    return (
                      <div className="code-block-wrapper">
                        <div className="code-block-header">
                          <span className="code-language">
                            {isBibtex && <BookOpen size={12} style={{ marginRight: 4 }} />}
                            {match[1]}
                          </span>
                          <button
                            className="code-copy-btn"
                            onClick={() => navigator.clipboard.writeText(codeString)}
                          >
                            <Copy size={12} />
                            <span>{isBibtex ? 'BibTeX 복사' : '코드 복사'}</span>
                          </button>
                        </div>
                        <pre className={className}>
                          <code {...props}>{children}</code>
                        </pre>
                      </div>
                    );
                  }
                  return (
                    <code className="inline-code" {...props}>
                      {children}
                    </code>
                  );
                },
                table({ children }) {
                  return (
                    <div className="table-responsive">
                      <table>{children}</table>
                    </div>
                  );
                }
              }}
            >
              {message.content}
            </ReactMarkdown>

            {/* Streaming indicator */}
            {(message.status === 'streaming' || message.isStreaming) && <span className="streaming-cursor" />}
          </div>

          {!isUser && message.contextBundle && citations && <section className="message-citations" aria-label="답변 근거">
            {message.contextBundle.retriever === 'graph-canonical-v1' && <p>정본 단독 문맥 · 레퍼런스 원문 0개. 자체 문서는 독립 외부 근거가 아니며 답변은 정합성 증명이 아닙니다.</p>}
            {message.contextBundle.hybrid && <p>검색: BM25 + 벡터 RRF · 세대 {message.contextBundle.hybrid.spaceId} · {message.contextBundle.hybrid.model}/{message.contextBundle.hybrid.dimensions}차원 · 의미 색인 {message.contextBundle.hybrid.coveredSpanIds.length}구간/미색인 {message.contextBundle.hybrid.missingSpanIds.length}구간 · 제공사 revision 미확인</p>}
            {message.contextBundle.hybrid?.manifestHash && <p>검색 당시 완성 manifest {message.contextBundle.hybrid.manifestHash} · 전환 번호 {message.contextBundle.hybrid.activationRevision} · 정합성 판정 아님</p>}
            <p>인용 ID와 전송 원문의 연결만 확인합니다. 의미적 지지·정합성은 미검증입니다.</p>
            {message.contextBundle.graph && <details><summary>답변의 정본 그래프 · 목표 {message.contextBundle.graph.context.targetBlockIds.length} / 추가 전제 {message.contextBundle.graph.context.premiseBlockIds.length}</summary>
              <p>전송 당시 버전·승인 관계 기록이며 검사 완료나 독립 외부 증거가 아닙니다.</p>
              <pre>{JSON.stringify(message.contextBundle.graph.context, null, 2)}</pre>
              {message.contextBundle.graph.blocks.map((block, index) => <div key={block.id}><p>[[G{index + 1}]] 블록 {block.id} · {block.contentHash}</p><pre>{block.text}</pre></div>)}
            </details>}
            {message.contextBundle.assembly && <details>
              <summary>연구 기준과 문맥 범위</summary>
              {message.contextBundle.projectScope && <><p>전송 당시 프로젝트 자료 정책 · 고정 기록이며 현재 정책이나 접근 제어의 증명이 아닙니다.</p><pre>{JSON.stringify(message.contextBundle.projectScope, null, 2)}</pre></>}
              <p>부모 문맥 {message.contextBundle.assembly.parentSpanIds.length}개 · 예산상 미전송 {message.contextBundle.assembly.omittedSpanIds.length}개</p>
              {!!message.contextBundle.assembly.omissions.length && <ul>{message.contextBundle.assembly.omissions.map(item =>
                <li key={item.spanId}>{item.name} · {spanLocation(item)} · 미전송</li>)}</ul>}
              {message.contextBundle.assembly.research ? <>
                <p>{message.contextBundle.assembly.research.title} · v{message.contextBundle.assembly.research.number} · 비어 있는 기준: {message.contextBundle.assembly.research.emptyFields.join(', ') || '없음'}</p>
                <pre>{JSON.stringify(message.contextBundle.assembly.research.contract, null, 2)}</pre>
                {message.contextBundle.assembly.research.contractAnchors && <p>전송 당시 정본 원문 연결: {JSON.stringify(message.contextBundle.assembly.research.contractAnchors)}. 블록 본문 전송이나 근거의 참을 의미하지 않습니다.</p>}
              </> : <p>연구 기준 미첨부 — 전제의 완전성 미확인</p>}
            </details>}
            {message.status === 'complete' && !citations.valid.length && <p role="alert">답변에 유효한 원문 인용이 없습니다.</p>}
            {!!citations.invalid.length && <p role="alert">전송 근거에 없는 인용: {citations.invalid.join(', ')}</p>}
            {message.contextBundle.evidence.map(item => <button type="button" key={item.citationId} onClick={() => onOpenSource?.(item)}>
              [[{item.citationId}]] {item.name} · {spanLocation(item.span)} · {citations.valid.includes(item.citationId) ? '답변에서 인용' : '전송 근거'} · 원문 보기
            </button>)}
          </section>}

          {!isUser && message.status === 'stopped' && (
            <div className="message-status stopped" role="status">
              <CircleStop size={14} />
              <span>{message.errorMessage}</span>
              {onRetry && (
                <button type="button" className="retry-btn" onClick={onRetry}>
                  <RotateCcw size={13} />
                  다시 시도
                </button>
              )}
            </div>
          )}

          {!isUser && message.status === 'error' && (
            <div className="message-status error" role="alert">
              <AlertTriangle size={14} />
              <span>{message.errorMessage}</span>
              {onRetry && (
                <button type="button" className="retry-btn" onClick={onRetry}>
                  <RotateCcw size={13} />
                  다시 시도
                </button>
              )}
            </div>
          )}

          {/* User message timestamp/actions */}
          {isUser && (
            <div className="user-message-footer">
              <button 
                id={`copy-user-btn-${message.id}`}
                className="copy-btn subtle" 
                onClick={handleCopy}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChatMessage;
