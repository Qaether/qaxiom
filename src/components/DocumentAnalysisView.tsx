import { lazy, Suspense, useState } from 'react';
import type { AnalysisFinding, AnalysisRun } from '../services/theory/analysis';
import type { TheorySnapshot } from '../services/theory/types';
import { GitCompare, FileText, Check, X, Clock, AlertCircle, RefreshCw, Trash2, CheckCircle2 } from 'lucide-react';

const MathJaxMarkdown = lazy(() => import('./MathJaxMarkdown'));

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
    <div className="document-analysis-diff-viewer" aria-label="원문과 수정안 비교">
      <div className="diff-side diff-before">
        <div className="diff-header">
          <span className="diff-tag minus">− 원문</span>
        </div>
        <pre className="diff-content">
          {change.prefix}
          <del>{change.removed}</del>
          {change.suffix}
        </pre>
      </div>
      <div className="diff-side diff-after">
        <div className="diff-header">
          <span className="diff-tag plus">+ AI 수정안</span>
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
  onSelectHistory?: (run: AnalysisRun) => void;
  onDecision: (finding: AnalysisFinding, decision: AnalysisFinding['decision']) => void;
  onApply: (finding: AnalysisFinding) => void;
  onRetry: () => void;
  onCancel: () => void;
  onDelete?: (run: AnalysisRun) => void;
  canApply: boolean;
}) {
  const [viewMode, setViewMode] = useState<'diff' | 'full'>('diff');
  const [filterMode, setFilterMode] = useState<'all' | 'pending' | 'completed'>('all');
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  const findings = run?.findings ?? [];
  const unchecked = run && Array.isArray(run.checkedBlockIds)
    ? snapshot.blocks.filter(block => !run.checkedBlockIds.includes(block.id)).length
    : 0;
  const appliedCount = findings.filter(f => f.decision === 'applied').length;
  const dismissedCount = findings.filter(f => f.decision === 'dismissed').length;
  const pendingFindings = findings.filter(f => f.decision === 'open' || f.decision === 'later');
  const completedFindings = findings.filter(f => f.decision === 'applied' || f.decision === 'dismissed');
  const allCompleted = findings.length > 0 && pendingFindings.length === 0;

  const displayedFindings = filterMode === 'pending'
    ? (pendingFindings.length > 0 ? pendingFindings : findings)
    : filterMode === 'completed'
    ? completedFindings
    : findings;

  return (
    <section className="document-analysis" aria-label="AI 분석 결과">
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
                  title="이전 정합성 분석 결과 보기"
                >
                  {history.map((item, idx) => (
                    <option key={item.id} value={item.id}>
                      {idx === 0 ? '최신 분석' : `${idx + 1}회차`} · {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ({item.findings.length}건 지적)
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <p className="document-analysis-meta">
            {run?.status === 'running'
              ? '문서 전체를 AI가 검토 중입니다. 편집 탭으로 이동해도 분석은 계속됩니다.'
              : run?.status === 'complete'
              ? `검토 의견 ${findings.length}건 (적용 ${appliedCount} · 기각 ${dismissedCount}) · ${run.modelId}`
              : run?.error || '저장된 문서의 분석 결과가 없습니다.'}
          </p>
        </div>

        <div className="document-analysis-header-actions">
          {/* 뷰 모드 토글: Diff 모아보기 vs 전체 문맥 보기 */}
          {run?.status === 'complete' && findings.length > 0 && (
            <div className="analysis-view-mode-toggle" role="tablist">
              <button
                type="button"
                className={`analysis-mode-btn ${viewMode === 'diff' ? 'active' : ''}`}
                onClick={() => setViewMode('diff')}
                title="AI 지적과 수정 Diff만 모아서 신속 검토"
              >
                <GitCompare size={14} />
                <span>Diff 모아보기 ({findings.length})</span>
              </button>
              <button
                type="button"
                className={`analysis-mode-btn ${viewMode === 'full' ? 'active' : ''}`}
                onClick={() => setViewMode('full')}
                title="전체 본문 문맥 안에서 지적 위치 확인"
              >
                <FileText size={14} />
                <span>전체 문맥 보기</span>
              </button>
            </div>
          )}

          {run?.status === 'running' ? (
            <button type="button" className="analysis-action-btn cancel" onClick={onCancel}>
              분석 취소
            </button>
          ) : (
            <button type="button" className="analysis-action-btn retry" onClick={onRetry}>
              <RefreshCw size={13} />
              <span>다시 분석</span>
            </button>
          )}

          {run && onDelete && (
            isConfirmingDelete ? (
              <div className="analysis-delete-confirm-group">
                <span className="confirm-label">삭제할까요?</span>
                <button
                  type="button"
                  className="analysis-action-btn delete-confirm-yes"
                  onClick={() => {
                    setIsConfirmingDelete(false);
                    onDelete(run);
                  }}
                  title="분석 결과 영구 삭제"
                >
                  확인
                </button>
                <button
                  type="button"
                  className="analysis-action-btn delete-confirm-no"
                  onClick={() => setIsConfirmingDelete(false)}
                  title="삭제 취소"
                >
                  취소
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="analysis-action-btn delete"
                onClick={() => setIsConfirmingDelete(true)}
                title="이 분석 결과 삭제"
              >
                <Trash2 size={13} />
                <span>삭제</span>
              </button>
            )
          )}
        </div>
      </header>

      <p className="document-analysis-disclaimer">
        AI의 검토 의견이며 이론의 참·증명 또는 완전한 정합성을 보장하지 않습니다. 외부 문헌은 대조하지 않았습니다.
      </p>

      {run?.status === 'running' && (
        <div className="document-analysis-running-banner" role="status">
          <div className="spinner" />
          <span>분석 요청을 처리하고 있습니다…</span>
        </div>
      )}

      {run?.status === 'complete' && (
        <>
          {!!unchecked && (
            <p role="status" className="document-analysis-warning">
              <AlertCircle size={14} />
              <span>{unchecked}개 블록은 모델이 검토했다고 보고하지 않았습니다.</span>
            </p>
          )}
          {run.limitations?.map((item, index) => (
            <p key={index} className="document-analysis-warning">
              <AlertCircle size={14} />
              <span>검토 한계: {item}</span>
            </p>
          ))}
          {!findings.length && (
            <div className="document-analysis-empty">
              <Check size={28} className="empty-check-icon" />
              <h3>지적된 정합성 오류가 없습니다</h3>
              <p>선택한 검토 기준에 따른 모순이나 반례 후보가 발견되지 않았습니다. (이론의 참을 보증하는 것은 아닙니다)</p>
            </div>
          )}

          {/* 모두 처리 완료 시 표시되는 축하 배너 */}
          {allCompleted && (
            <div className="document-analysis-all-completed-banner" role="status">
              <CheckCircle2 size={24} className="all-completed-icon" />
              <div className="all-completed-content">
                <strong>모든 검토 의견이 처리되었습니다! (적용 {appliedCount}건 · 기각 {dismissedCount}건)</strong>
                <p>선택한 검토 지적 사항에 대한 처리가 모두 완료되었습니다. 아래 목록에서 언제든지 기각/적용 상태를 재조정할 수 있습니다.</p>
              </div>
            </div>
          )}

          {/* 필터 탭: 전체 / 검토 필요 / 처리 완료 */}
          {findings.length > 0 && (
            <div className="analysis-filter-bar">
              <div className="analysis-filter-tabs" role="tablist">
                <button
                  type="button"
                  className={`analysis-filter-tab ${filterMode === 'all' ? 'active' : ''}`}
                  onClick={() => setFilterMode('all')}
                >
                  <span>전체 ({findings.length})</span>
                </button>
                <button
                  type="button"
                  className={`analysis-filter-tab ${filterMode === 'pending' ? 'active' : ''}`}
                  onClick={() => setFilterMode('pending')}
                >
                  <span>검토 필요 ({pendingFindings.length})</span>
                </button>
                <button
                  type="button"
                  className={`analysis-filter-tab ${filterMode === 'completed' ? 'active' : ''}`}
                  onClick={() => setFilterMode('completed')}
                >
                  <span>처리 완료 ({completedFindings.length})</span>
                </button>
              </div>
            </div>
          )}

          {/* =========================================================================
              모드 1: Diff 모아보기 피드 (Diff-Centric View - 기본값)
              ========================================================================= */}
          {viewMode === 'diff' && displayedFindings.length > 0 && (
            <div className="document-analysis-diff-feed">
              {displayedFindings.map((finding, index) => {
                const block = snapshot.blocks.find(b => b.id === finding.blockId);
                const isApplied = finding.decision === 'applied';
                const isDismissed = finding.decision === 'dismissed';
                const isLater = finding.decision === 'later';

                return (
                  <article
                    id={`analysis-${finding.id}`}
                    key={finding.id}
                    className={`analysis-diff-card ${finding.decision}`}
                  >
                    <div className="analysis-diff-card-header">
                      <div className="diff-card-meta">
                        <span className="diff-card-badge">#{index + 1}</span>
                        <strong>{finding.explanation}</strong>
                      </div>
                      <div className="analysis-card-actions">
                        {finding.replacement ? (
                          <button
                            type="button"
                            className={`card-apply-btn ${isApplied ? 'applied' : ''}`}
                            disabled={!canApply || isApplied}
                            onClick={() => onApply(finding)}
                          >
                            <Check size={14} />
                            <span>{isApplied ? '적용 완료' : '편집 내용에 적용'}</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={`card-apply-btn ${isApplied ? 'applied' : ''}`}
                            onClick={() => onDecision(finding, isApplied ? 'open' : 'applied')}
                            title="이 지적 및 조치 조건을 확인 완료로 처리"
                          >
                            <Check size={14} />
                            <span>{isApplied ? '확인 완료' : '확인 완료'}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          className={`card-decision-btn ${isDismissed ? 'active' : ''}`}
                          aria-pressed={isDismissed}
                          onClick={() => onDecision(finding, isDismissed ? 'open' : 'dismissed')}
                          title="지적 무시/기각"
                        >
                          <X size={14} />
                          <span>기각</span>
                        </button>
                        <button
                          type="button"
                          className={`card-decision-btn ${isLater ? 'active' : ''}`}
                          aria-pressed={isLater}
                          onClick={() => onDecision(finding, isLater ? 'open' : 'later')}
                          title="나중에 검토"
                        >
                          <Clock size={14} />
                          <span>나중에</span>
                        </button>
                      </div>
                    </div>

                    <div className="analysis-diff-card-body">
                      <div className="diff-card-quote-box">
                        <span className="quote-label">원문 인용:</span>
                        <q>{finding.quote}</q>
                      </div>

                      <div className="diff-card-condition-box">
                        <span className="condition-label">확인할 조건:</span>
                        <span>{finding.resolution}</span>
                      </div>

                      {/* 원문과 수정안 Diff를 기본으로 즉시 표시 */}
                      {finding.replacement && block ? (
                        <SuggestionDiffViewer before={block.text} after={finding.replacement} />
                      ) : (
                        <p className="no-replacement-note">
                          💡 텍스트 교체안 없이 확인 조건만 제시된 지적 사항입니다.
                        </p>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {/* =========================================================================
              모드 2: 전체 문맥 보기 뷰 (Full Document Context View)
              ========================================================================= */}
          {viewMode === 'full' && (
            <div className="document-analysis-blocks">
              {snapshot.blocks.map(block => (
                <section key={block.id} className="document-analysis-block">
                  <div className="document-analysis-original">
                    <Suspense fallback={<pre>{block.text}</pre>}>
                      <MathJaxMarkdown content={block.text} />
                    </Suspense>
                  </div>
                  {findings
                    .filter(item => item.blockId === block.id)
                    .map(finding => (
                      <article
                        id={`analysis-${finding.id}`}
                        key={finding.id}
                        className={`document-analysis-comment ${finding.decision}`}
                      >
                        <span className="document-analysis-arrow" aria-hidden="true">==&gt;</span>
                        <div>
                          <p><strong>AI 검토</strong> · 원문: <q>{finding.quote}</q></p>
                          <p>{finding.explanation}</p>
                          <p>확인할 조건: {finding.resolution}</p>
                          {finding.replacement && (
                            <div className="inline-diff-box">
                              <SuggestionDiffViewer before={block.text} after={finding.replacement} />
                              <button
                                type="button"
                                className="inline-apply-btn"
                                disabled={!canApply || finding.decision === 'applied'}
                                onClick={() => onApply(finding)}
                              >
                                {finding.decision === 'applied' ? '적용 완료' : '편집 내용에 적용'}
                              </button>
                            </div>
                          )}
                          <div className="document-analysis-decisions">
                            <button
                              type="button"
                              aria-pressed={finding.decision === 'later'}
                              onClick={() => onDecision(finding, 'later')}
                            >
                              나중에 검토
                            </button>
                            <button
                              type="button"
                              aria-pressed={finding.decision === 'dismissed'}
                              onClick={() => onDecision(finding, 'dismissed')}
                            >
                              기각
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
