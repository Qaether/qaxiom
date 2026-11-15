import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { AnalysisFinding, AnalysisRun } from '../services/theory/analysis';
import type { TheorySnapshot } from '../services/theory/types';
import { Check, X, Clock, AlertCircle, RefreshCw, Trash2, CheckCircle2, RotateCcw, Sigma } from 'lucide-react';
import { preprocessLatex } from './mathMarkdown';

const MathJaxMarkdown = lazy(() => import('./MathJaxMarkdown'));

export interface AnalysisProgress {
  runId: string;
  stage: string;
  startedAt: number;
  receivedChars: number;
  reasoningSummary: string;
  summaryTruncated?: boolean;
}

function AnalysisText({ content, renderMath }: { content: string; renderMath: boolean }) {
  if (!renderMath) return <span className="analysis-source-text">{content}</span>;
  return <Suspense fallback={<span>{content}</span>}><MathJaxMarkdown content={preprocessLatex(content)} /></Suspense>;
}

function ProgressDetails({ run, progress, elapsedSeconds }: {
  run: AnalysisRun; progress: AnalysisProgress; elapsedSeconds: number;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (details.current) details.current.open = run.status === 'running'; }, [run.status]);
  return (
    <details ref={details} className="document-analysis-progress">
      <summary>
        {run.status === 'running' && <span className="spinner" aria-hidden="true" />}
        <strong>Analysis in progress · {progress.stage}</strong>
        <span>{run.status === 'running' ? `${elapsedSeconds}s elapsed` : 'View details'}</span>
      </summary>
      <div className="document-analysis-progress-body">
        <p role="status">{progress.stage}{progress.receivedChars > 0 ? ` · Received ${progress.receivedChars.toLocaleString()} chars` : ''}</p>
        {progress.reasoningSummary ? (
          <div className="document-analysis-reasoning">
            <strong>Model reasoning summary</strong>
            <div className="analysis-source-text">{progress.reasoningSummary}</div>
            {progress.summaryTruncated && <p className="document-analysis-progress-note">Long summaries are truncated to the last 20,000 characters.</p>}
          </div>
        ) : <p className="document-analysis-progress-note">No public reasoning summary from this model yet.</p>}
      </div>
    </details>
  );
}

function changedSpan(before: string = '', after: string = '') {
  const b = before ?? '';
  const a = after ?? '';
  let start = 0;
  while (start < b.length && start < a.length && b[start] === a[start]) start++;
  let end = 0;
  while (end < b.length - start && end < a.length - start
    && b[b.length - end - 1] === a[a.length - end - 1]) end++;
  return {
    prefix: b.slice(0, start),
    removed: b.slice(start, b.length - end),
    added: a.slice(start, a.length - end),
    suffix: end ? b.slice(b.length - end) : ''
  };
}

function SuggestionDiffViewer({ before, after }: { before: string; after: string }) {
  const change = changedSpan(before, after);
  return (
    <div className="document-analysis-diff-viewer" aria-label="Compare original and suggested revision">
      <div className="diff-side diff-before">
        <div className="diff-header">
          <span className="diff-tag minus">− Original</span>
        </div>
        <pre className="diff-content">
          {change.prefix}
          <del>{change.removed}</del>
          {change.suffix}
        </pre>
      </div>
      <div className="diff-side diff-after">
        <div className="diff-header">
          <span className="diff-tag plus">+ AI Suggestion</span>
        </div>
        <pre className="diff-content">
          {change.prefix}
          <ins>{change.added}</ins>
          {change.suffix}
        </pre>
      </div>
    </div>
  );
}

export default function DocumentAnalysisView({
  snapshot,
  run,
  history,
  progress,
  onSelectHistory,
  onDecision,
  onApply,
  onRetry,
  onCancel,
  onDelete,
  canApply
}: {
  snapshot: TheorySnapshot;
  run: AnalysisRun | null;
  history?: AnalysisRun[];
  progress?: AnalysisProgress | null;
  onSelectHistory?: (run: AnalysisRun) => void;
  onDecision: (finding: AnalysisFinding, decision: AnalysisFinding['decision']) => void;
  onApply: (finding: AnalysisFinding) => void;
  onRetry: () => void;
  onCancel: () => void;
  onDelete?: (run: AnalysisRun) => void;
  canApply: boolean;
}) {
  const [filterMode, setFilterMode] = useState<'all' | 'pending' | 'completed'>('all');
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [renderMath, setRenderMath] = useState(true);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (run?.status !== 'running' || progress?.runId !== run.id) return;
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - progress.startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status, progress?.runId, progress?.startedAt]);

  const findings = run?.findings ?? [];
  const unchecked = run && Array.isArray(run.checkedBlockIds)
    ? snapshot.blocks.filter(block => !run.checkedBlockIds.includes(block.id)).length
    : 0;
  const appliedCount = findings.filter(f => f.decision === 'applied').length;
  const dismissedCount = findings.filter(f => f.decision === 'dismissed').length;
  const pendingFindings = findings.filter(f => f.decision === 'open' || f.decision === 'later');
  const completedFindings = findings.filter(f => f.decision === 'applied' || f.decision === 'dismissed');
  const allCompleted = findings.length > 0 && pendingFindings.length === 0;
  const visibleProgress = run && progress?.runId === run.id ? progress : null;

  const displayedFindings = filterMode === 'pending'
    ? pendingFindings
    : filterMode === 'completed'
    ? completedFindings
    : findings;

  return (
    <section className="document-analysis" aria-label="AI analysis results">
      <header className="document-analysis-header">
        <div className="document-analysis-title-group">
          <div className="document-analysis-title-row">
            <strong>{snapshot.version.title} · v{snapshot.version.number}</strong>
            {history && history.length > 1 && onSelectHistory && (
              <div className="document-analysis-history-box">
                <Clock size={13} />
                <select
                  className="analysis-history-select"
                  value={run?.id ?? ''}
                  onChange={e => {
                    const selected = history.find(h => h.id === e.target.value);
                    if (selected) onSelectHistory(selected);
                  }}
                  title="View previous consistency analysis results"
                >
                  {history.map((item, idx) => (
                    <option key={item.id} value={item.id}>
                      {idx === 0 ? 'Latest' : `Run #${idx + 1}`} · {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ({item.findings.length} findings)
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <p className="document-analysis-meta">
            {run?.status === 'running'
              ? 'AI is reviewing the full document. Analysis continues even if you switch to the Edit tab.'
              : run?.status === 'complete'
              ? `${findings.length} findings (Applied ${appliedCount} · Dismissed ${dismissedCount}) · ${run.modelId}`
              : run?.error || 'No saved analysis results for this document.'}
          </p>
        </div>

        <div className="document-analysis-header-actions">

          {run?.status === 'running' ? (
            <button type="button" className="analysis-action-btn cancel" onClick={onCancel}>
              Cancel analysis
            </button>
          ) : (
            <button type="button" className="analysis-action-btn retry" onClick={onRetry}>
              <RefreshCw size={13} />
              <span>Re-analyze</span>
            </button>
          )}

          {run && onDelete && (
            isConfirmingDelete ? (
              <div className="analysis-delete-confirm-group">
                <span className="confirm-label">Delete?</span>
                <button
                  type="button"
                  className="analysis-action-btn delete-confirm-yes"
                  onClick={() => {
                    setIsConfirmingDelete(false);
                    onDelete(run);
                  }}
                  title="Permanently delete analysis result"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  className="analysis-action-btn delete-confirm-no"
                  onClick={() => setIsConfirmingDelete(false)}
                  title="Cancel deletion"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="analysis-action-btn delete"
                onClick={() => setIsConfirmingDelete(true)}
                title="Delete this analysis result"
              >
                <Trash2 size={13} />
                <span>Delete</span>
              </button>
            )
          )}
        </div>
      </header>

      <p className="document-analysis-disclaimer">
        These are AI review suggestions and do not guarantee truth, proof, or full consistency. External literature was not checked.
      </p>

      {run && visibleProgress && <ProgressDetails key={`${run.id}-${run.status}`} run={run} progress={visibleProgress} elapsedSeconds={elapsedSeconds} />}

      {run?.status === 'running' && !visibleProgress && (
        <div className="document-analysis-running-banner" role="status">
          <div className="spinner" />
          <span>Processing analysis request…</span>
        </div>
      )}

      {run?.status === 'complete' && (
        <>
          {!!unchecked && (
            <p role="status" className="document-analysis-warning">
              <AlertCircle size={14} />
              <span>{unchecked} block(s) were not reported as reviewed by the model.</span>
            </p>
          )}
          {run.limitations?.map((item, index) => (
            <p key={index} className="document-analysis-warning">
              <AlertCircle size={14} />
              <span>Review limitation: {item}</span>
            </p>
          ))}
          {!findings.length && (
            <div className="document-analysis-empty">
              <Check size={28} className="empty-check-icon" />
              <h3>No consistency issues found</h3>
              <p>No contradictions or counterexample candidates were found under the selected criteria. (Does not guarantee the theory is true.)</p>
            </div>
          )}

          {/* Banner shown when all findings are resolved */}
          {allCompleted && (
            <div className="document-analysis-all-completed-banner" role="status">
              <CheckCircle2 size={24} className="all-completed-icon" />
              <div className="all-completed-content">
                <strong>All review findings have been processed! (Applied {appliedCount} · Dismissed {dismissedCount})</strong>
                <p>All selected findings have been handled. You can adjust applied/dismissed statuses anytime below.</p>
              </div>
            </div>
          )}

          {/* Filter tabs: All / Pending / Completed */}
          {findings.length > 0 && (
            <div className="analysis-filter-bar">
              <div className="analysis-filter-tabs" role="tablist">
                <button
                  type="button"
                  className={`analysis-filter-tab ${filterMode === 'all' ? 'active' : ''}`}
                  onClick={() => setFilterMode('all')}
                >
                  <span>All ({findings.length})</span>
                </button>
                <button
                  type="button"
                  className={`analysis-filter-tab ${filterMode === 'pending' ? 'active' : ''}`}
                  onClick={() => setFilterMode('pending')}
                >
                  <span>Pending ({pendingFindings.length})</span>
                </button>
                <button
                  type="button"
                  className={`analysis-filter-tab ${filterMode === 'completed' ? 'active' : ''}`}
                  onClick={() => setFilterMode('completed')}
                >
                  <span>Completed ({completedFindings.length})</span>
                </button>
              </div>
              <button type="button" className="analysis-math-toggle" aria-pressed={renderMath} onClick={() => setRenderMath(value => !value)}>
                <Sigma size={15} aria-hidden="true" />
                <span>{renderMath ? 'View Source' : 'Render Math'}</span>
              </button>
            </div>
          )}

          {/* Empty state for selected filter */}
          {findings.length > 0 && displayedFindings.length === 0 && (
            <div className="document-analysis-filter-empty" role="status">
              <CheckCircle2 size={20} className="filter-empty-icon" />
              <span>
                {filterMode === 'pending'
                  ? 'No pending findings to review. (All findings processed.)'
                  : filterMode === 'completed'
                  ? 'No completed (applied or dismissed) findings yet.'
                  : 'No findings to display.'}
              </span>
            </div>
          )}

          {/* Full Document Context View */}
          <div className="document-analysis-blocks">
            {(filterMode === 'all'
              ? snapshot.blocks
              : snapshot.blocks.filter(block => displayedFindings.some(item => item.blockId === block.id))
            ).map(block => {
              const blockFindings = displayedFindings.filter(item => item.blockId === block.id);
              return (
                <section key={block.id} className="document-analysis-block">
                  <div className="document-analysis-original">
                    {renderMath ? <AnalysisText content={block.text} renderMath /> : <pre className="analysis-source-block">{block.text}</pre>}
                  </div>
                  {blockFindings.map(finding => {
                    const isApplied = finding.decision === 'applied';
                    const isDismissed = finding.decision === 'dismissed';
                    const isLater = finding.decision === 'later';

                    return (
                      <article
                        id={`analysis-${finding.id}`}
                        key={finding.id}
                        className={`document-analysis-comment ${finding.decision}`}
                      >
                        <span className="document-analysis-arrow" aria-hidden="true">==&gt;</span>
                        <div>
                          <div className="analysis-finding-quote"><strong>AI Review</strong> · Source quote:<div><AnalysisText content={finding.quote} renderMath={renderMath} /></div></div>
                          <div className="analysis-finding-prose"><AnalysisText content={finding.explanation} renderMath={renderMath} /></div>
                          <div className="analysis-finding-prose"><strong>Condition to check</strong><AnalysisText content={finding.resolution} renderMath={renderMath} /></div>
                          {isApplied || isDismissed ? (
                            <div className={`analysis-status-badge ${finding.decision}`}>
                              <span className="status-text">
                                {isDismissed
                                  ? '🚫 Dismissed finding.'
                                  : `✓ ${finding.replacement ? 'Applied to draft.' : 'Marked as checked.'}`}
                              </span>
                              <button
                                type="button"
                                className="status-revert-btn"
                                onClick={() => onDecision(finding, 'open')}
                                title="Undo this decision and review again"
                              >
                                <RotateCcw size={13} />
                                <span>Review again</span>
                              </button>
                            </div>
                          ) : (
                            <>
                              {finding.replacement ? (
                                <div className="inline-diff-box">
                                  <SuggestionDiffViewer before={block.text} after={finding.replacement} />
                                  {renderMath && <div className="analysis-replacement-preview"><strong>Suggested revision math preview</strong><AnalysisText content={finding.replacement} renderMath /></div>}
                                  <button
                                    type="button"
                                    className="inline-apply-btn"
                                    disabled={!canApply}
                                    onClick={() => onApply(finding)}
                                  >
                                    <Check size={14} />
                                    <span>Apply to draft</span>
                                  </button>
                                </div>
                              ) : (
                                <p className="no-replacement-note">
                                  💡 Finding provides a condition to check without a text replacement.
                                </p>
                              )}
                              <div className="document-analysis-decisions">
                                {!finding.replacement && (
                                  <button
                                    type="button"
                                    className="card-apply-btn"
                                    onClick={() => onDecision(finding, 'applied')}
                                  >
                                    <Check size={14} />
                                    <span>Mark checked</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="card-decision-btn"
                                  onClick={() => onDecision(finding, 'dismissed')}
                                  title="Ignore/dismiss finding"
                                >
                                  <X size={14} />
                                  <span>Dismiss</span>
                                </button>
                                <button
                                  type="button"
                                  className={`card-decision-btn ${isLater ? 'active' : ''}`}
                                  aria-pressed={isLater}
                                  onClick={() => onDecision(finding, isLater ? 'open' : 'later')}
                                  title="Review later"
                                >
                                  <Clock size={14} />
                                  <span>Later</span>
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </section>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
