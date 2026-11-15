import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { AlertTriangle, BookOpen, Check, CircleStop, Copy, FileDown, RotateCcw, User } from 'lucide-react';
import type { ChatMessage as ChatMessageType } from '../types';
import type { ContextEvidence } from '../services/retrieval/types';
import { inspectCitations } from '../services/retrieval/context';
import { spanLocation } from '../services/retrieval/pdfTypes';
import { parseMessageFileChanges, type FileChangeItem } from '../services/fileChanges';
import { FilesWithChanges } from './FilesWithChanges';
import { preprocessLatex } from './mathMarkdown';
import './References.css';
import 'katex/dist/katex.min.css';

interface ChatMessageProps {
  message: ChatMessageType;
  onRetry?: () => void;
  onOpenSource?: (evidence: ContextEvidence) => void;
  onApplyToDocument?: (content: string) => void;
  onDirectAcceptDocument?: (content: string) => void;
  onAppendToDocument?: (content: string) => void;
  originalDocumentContent?: string;
  onRejectDocumentChange?: () => void;
  changeStatus?: 'pending' | 'accepted' | 'rejected';
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  onRetry,
  onOpenSource,
  onApplyToDocument,
  onDirectAcceptDocument,
  onAppendToDocument,
  originalDocumentContent,
  onRejectDocumentChange,
  changeStatus,
}) => {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState(false);
  const [localChangeStatus, setLocalChangeStatus] = useState<'pending' | 'accepted' | 'rejected'>('pending');
  const currentStatus = changeStatus ?? localChangeStatus;

  const defaultFilename = message.documentContext?.title ? `${message.documentContext.title}.md` : 'document.md';
  const parsed = React.useMemo(() => {
    if (isUser) return { displayText: message.content, fileChanges: [] };
    return parseMessageFileChanges(message.content, defaultFilename);
  }, [isUser, message.content, defaultFilename]);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleApply = (content: string) => {
    if (onAppendToDocument) {
      onAppendToDocument(content);
    } else if (onDirectAcceptDocument) {
      onDirectAcceptDocument(content);
    } else if (onApplyToDocument) {
      onApplyToDocument(content);
    }
    setApplied(true);
    setLocalChangeStatus('accepted');
    setTimeout(() => setApplied(false), 2000);
  };

  const handleReviewChange = (change: FileChangeItem) => {
    if (!onApplyToDocument) return;
    onApplyToDocument(change.proposedContent);
  };

  const handleAcceptChange = (change: FileChangeItem) => {
    if (onDirectAcceptDocument) {
      onDirectAcceptDocument(change.proposedContent);
    } else if (onApplyToDocument) {
      onApplyToDocument(change.proposedContent);
    }
    setLocalChangeStatus('accepted');
  };

  const handleRejectChange = () => {
    setLocalChangeStatus('rejected');
    if (onRejectDocumentChange) {
      onRejectDocumentChange();
    }
  };

  const citations = message.contextBundle ? inspectCitations(message.content, message.contextBundle) : null;

  return (
    <div className={`message-row ${isUser ? 'user-message-row' : 'assistant-message-row'}`}>
      <div className="message-container">
        {isUser && <div className="message-avatar user-avatar"><User size={18} /></div>}

        <div className="message-body">
          {/* Content */}
          <div className="markdown-content">
            <ReactMarkdown
              remarkPlugins={[remarkMath, remarkGfm]}
              rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
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
                          <div className="code-header-actions">
                            {onApplyToDocument && (
                              <button
                                type="button"
                                className="code-apply-btn"
                                onClick={() => handleApply(codeString)}
                                title="Apply this content to the center research note"
                                aria-label="Apply to note"
                              >
                                <FileDown size={12} />
                                <span>Apply to note</span>
                              </button>
                            )}
                            <button
                              className="code-copy-btn"
                              onClick={() => navigator.clipboard.writeText(codeString)}
                            >
                              <Copy size={12} />
                              <span>{isBibtex ? 'Copy BibTeX' : 'Copy code'}</span>
                            </button>
                          </div>
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
              {preprocessLatex(parsed.displayText)}
            </ReactMarkdown>

            {/* Streaming indicator */}
            {(message.status === 'streaming' || message.isStreaming) && <span className="streaming-cursor" />}
          </div>

          {/* Google Antigravity Style Files with changes */}
          {!isUser && parsed.fileChanges.length > 0 && (
            <FilesWithChanges
              changes={parsed.fileChanges}
              originalContent={message.documentContext?.markdown || originalDocumentContent || ''}
              status={currentStatus}
              onReview={handleReviewChange}
              onAccept={handleAcceptChange}
              onReject={handleRejectChange}
            />
          )}

          {!isUser && message.contextBundle && citations && <section className="message-citations" aria-label="Response sources">
            {message.contextBundle.retriever === 'graph-canonical-v1' && <p>Canonical-only context · 0 reference sources. Internal notes are not independent external evidence, and responses do not prove consistency.</p>}
            {message.contextBundle.hybrid && <p>Retrieval: BM25 + vector RRF · Space {message.contextBundle.hybrid.spaceId} · {message.contextBundle.hybrid.model}/{message.contextBundle.hybrid.dimensions}d · Indexed {message.contextBundle.hybrid.coveredSpanIds.length} spans / Unindexed {message.contextBundle.hybrid.missingSpanIds.length} spans · Provider revision unverified</p>}
            {message.contextBundle.hybrid?.manifestHash && <p>Retrieval manifest {message.contextBundle.hybrid.manifestHash} · Activation revision {message.contextBundle.hybrid.activationRevision} · Not a consistency verdict</p>}
            <p>Verifies only the link between citation IDs and sent source text. Semantic support and consistency are unverified.</p>
            {message.contextBundle.graph && <details><summary>Canonical graph for response · {message.contextBundle.graph.context.targetBlockIds.length} targets / {message.contextBundle.graph.context.premiseBlockIds.length} additional premises</summary>
              <p>Snapshot of version and approval links at send time; not a verification result or independent external evidence.</p>
              <pre>{JSON.stringify(message.contextBundle.graph.context, null, 2)}</pre>
              {message.contextBundle.graph.blocks.map((block, index) => <div key={block.id}><p>[[G{index + 1}]] Block {block.id} · {block.contentHash}</p><pre>{block.text}</pre></div>)}
            </details>}
            {message.contextBundle.assembly && <details>
              <summary>Research contract and context scope</summary>
              {message.contextBundle.projectScope && <><p>Project material policy at send time · Fixed snapshot, not a guarantee of current policy or access control.</p><pre>{JSON.stringify(message.contextBundle.projectScope, null, 2)}</pre></>}
              <p>{message.contextBundle.assembly.parentSpanIds.length} parent context spans · {message.contextBundle.assembly.omittedSpanIds.length} omitted due to budget</p>
              {!!message.contextBundle.assembly.omissions.length && <ul>{message.contextBundle.assembly.omissions.map(item =>
                <li key={item.spanId}>{item.name} · {spanLocation(item)} · Not sent</li>)}</ul>}
              {message.contextBundle.assembly.research ? <>
                <p>{message.contextBundle.assembly.research.title} · v{message.contextBundle.assembly.research.number} · Empty fields: {message.contextBundle.assembly.research.emptyFields.join(', ') || 'None'}</p>
                <pre>{JSON.stringify(message.contextBundle.assembly.research.contract, null, 2)}</pre>
                {message.contextBundle.assembly.research.contractAnchors && <p>Canonical source links at send time: {JSON.stringify(message.contextBundle.assembly.research.contractAnchors)}. Does not imply block text transmission or truth of evidence.</p>}
              </> : <p>Research contract not attached — premise completeness unverified</p>}
            </details>}
            {message.status === 'complete' && !citations.valid.length && <p role="alert">No valid source citations in response.</p>}
            {!!citations.invalid.length && <p role="alert">Citations not in sent sources: {citations.invalid.join(', ')}</p>}
            {message.contextBundle.evidence.map(item => <button type="button" key={item.citationId} onClick={() => onOpenSource?.(item)}>
              [[{item.citationId}]] {item.name} · {spanLocation(item.span)} · {citations.valid.includes(item.citationId) ? 'Cited in response' : 'Sent source'} · View source
            </button>)}
          </section>}

          {!isUser && message.status === 'stopped' && (
            <div className="message-status stopped" role="status">
              <CircleStop size={14} />
              <span>{message.errorMessage}</span>
              {onRetry && (
                <button type="button" className="retry-btn" onClick={onRetry}>
                  <RotateCcw size={13} />
                  Retry
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
                  Retry
                </button>
              )}
            </div>
          )}

          {!isUser && <div className="assistant-message-footer">
            {onApplyToDocument && message.status === 'complete' && message.content && parsed.fileChanges.length === 0 && (
              <button
                type="button"
                id={`apply-btn-${message.id}`}
                className={`apply-doc-btn ${applied ? 'applied' : ''}`}
                onClick={() => handleApply(message.content)}
                title={applied ? 'Applied to note' : 'Apply this response to the center research note'}
                aria-label={applied ? 'Applied to note' : 'Apply to research note'}
              >
                {applied ? <Check size={14} className="copied-icon" /> : <FileDown size={14} />}
                <span>{applied ? 'Applied' : 'Apply to note'}</span>
              </button>
            )}
            <button
              type="button"
              id={`copy-btn-${message.id}`}
              className="copy-btn"
              onClick={handleCopy}
              title={copied ? 'Copied' : 'Copy response'}
              aria-label={copied ? 'Copied' : 'Copy response'}
            >
              {copied ? <Check size={14} className="copied-icon" /> : <Copy size={14} />}
            </button>
          </div>}

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
