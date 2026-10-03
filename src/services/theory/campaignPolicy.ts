import type { ReviewIssue, ReviewRun } from './reviewTypes';
import type { ReviewCampaign } from './campaigns';

export const STOP_REASONS = ['critical_issue', 'repeated_issue', 'previously_resolved_issue', 'review_failure', 'insufficient_evidence'] as const;
export type CampaignStopReason = typeof STOP_REASONS[number];
export const STOP_LABELS: Record<CampaignStopReason, string> = {
  critical_issue: '중대 Issue 발견', repeated_issue: '동일 근거의 Issue 반복 후보',
  previously_resolved_issue: '과거 해결 표시 Issue의 재발 후보', review_failure: '검토 실패 또는 중단',
  insufficient_evidence: '선택 범위 미검사 또는 판단 근거 부족'
};

// A conservative structural match, not semantic equivalence or proof of recurrence.
export function issueFingerprint(issue: ReviewIssue) {
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return JSON.stringify([issue.kind, issue.blockIds.map((id, i) => [id, normalize(issue.quotes[i])])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))]);
}

export function runStopReasons(run: ReviewRun, requested: string[], runs: ReviewRun[]): CampaignStopReason[] {
  if (run.status !== 'complete') return ['review_failure'];
  const reasons: CampaignStopReason[] = [];
  if (run.issues.some(issue => issue.severity === 'critical' && !issue.resolvedByRunId)) reasons.push('critical_issue');
  const current = new Set(run.issues.filter(issue => !issue.resolvedByRunId).map(issueFingerprint));
  const prior = runs.filter(previous => previous.documentId === run.documentId && previous.checker === run.checker
    && previous.id !== run.id && previous.status === 'complete' && previous.createdAt <= run.createdAt);
  if (prior.some(previous => previous.issues.some(issue => current.has(issueFingerprint(issue))))) reasons.push('repeated_issue');
  if (prior.some(previous => previous.issues.some(issue => issue.resolvedByRunId && current.has(issueFingerprint(issue))))) reasons.push('previously_resolved_issue');
  if (run.limitations.length || requested.some(id => !run.checkedBlockIds.includes(id))
    || run.issues.some(issue => !issue.resolvedByRunId && issue.kind === 'insufficient_evidence')) reasons.push('insufficient_evidence');
  return reasons;
}

export function campaignStop(campaign: ReviewCampaign, runs: ReviewRun[]) {
  const attempt = campaign.attempts.at(-1);
  const run = attempt?.runId ? runs.find(run => run.id === attempt.runId) : undefined;
  if (!attempt || !run) return null;
  const reasons = runStopReasons(run, attempt.blockIds, runs);
  const confirmed = new Set((campaign.confirmations ?? []).filter(item => item.runId === run.id).flatMap(item => item.reasons));
  const pending = reasons.filter(reason => !confirmed.has(reason));
  return pending.length ? { runId: run.id, reasons: pending } : null;
}
