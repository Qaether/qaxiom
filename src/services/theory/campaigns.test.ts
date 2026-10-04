// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createTheory, saveTheoryVersion } from './documents';
import { EMPTY_CONTRACT } from './types';
import { reviewSkeleton } from './reviews';
import { activeAttempt, changeCampaignBudget, closeCampaign, confirmCampaignResume, ensureCampaign, finishReviewAttempt, getCampaign, pendingBatches, planReviewBatches, recoverExpiredAttempt, reserveReviewAttempt, saveReviewPlan, startNewCampaign } from './campaigns';
import { campaignStop, issueFingerprint, runStopReasons } from './campaignPolicy';
import type { ReviewRun, ReviewIssue } from './reviewTypes';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`campaign-${crypto.randomUUID()}`); target = new QaxiomDatabase(`campaign-target-${crypto.randomUUID()}`); });
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); await target.delete(); });
async function fixture() {
  const snapshot = await createTheory({ title: '분할 검토', markdown: ['가'.repeat(8000), '나'.repeat(8000), '다'.repeat(8000)].join('\n\n'), contract: { ...EMPTY_CONTRACT, assumptions: '필수 기준 전체' } }, db);
  return { snapshot, ids: snapshot.blocks.map(b => b.id), campaign: await ensureCampaign(snapshot.document.id, db) };
}

it('appends schema v6 and preserves populated v5 workspaces', async () => {
  const { snapshot } = await fixture(); const legacy = new Dexie(target.name);
  const tables = db.tables.filter(t => !['review_campaigns', 'embedding_spaces', 'embedding_vectors', 'embedding_manifests', 'embedding_activations', 'research_relations'].includes(t.name));
  legacy.version(5).stores(Object.fromEntries(tables.map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const table of tables) await legacy.table(table.name).bulkAdd(await table.toArray());
  legacy.close(); await target.open();
  expect(target.verno).toBe(25); expect(await target.document_versions.get(snapshot.version.id)).toEqual(snapshot.version);
  expect(await target.review_campaigns.count()).toBe(0);
});

it('reserves only one owner across concurrent tabs, retaining a charged attempt after reload', async () => {
  const { snapshot, ids, campaign } = await fixture();
  const second = new QaxiomDatabase(db.name);
  try {
    const results = await Promise.allSettled([reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db), reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', second)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const saved = await ensureCampaign(snapshot.document.id, second);
    expect(saved.attempts).toHaveLength(1); expect(activeAttempt(saved)?.modelId).toBe('model');
    await expect(changeCampaignBudget(campaign.id, 4, db)).rejects.toThrow('실행 중');
  } finally { second.close(); }
});

it('keeps the full document in one planned request and tracks unchecked blocks', async () => {
  const { snapshot, ids, campaign } = await fixture();
  expect(planReviewBatches(snapshot, ids)).toEqual([ids]);
  await saveReviewPlan(campaign.id, snapshot, ids, db);
  const attempt = await reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db);
  const run = reviewSkeleton(snapshot, 'llm-v1', [ids[0]], 'model');
  run.outcome = 'insufficient';
  const saved = await finishReviewAttempt(campaign.id, attempt.token, run, db);
  expect(pendingBatches(saved, [run])).toEqual([[ids[1], ids[2]]]);
  const next = await saveTheoryVersion(snapshot.document.id, snapshot.version.id, { title: snapshot.version.title, markdown: '새 버전', contract: snapshot.version.contract }, db);
  expect((await ensureCampaign(next.document.id, db)).attempts).toHaveLength(1);
  await expect(reserveReviewAttempt(campaign.id, snapshot, [ids[1]], 'model', db)).rejects.toThrow('버전');
  await changeCampaignBudget(campaign.id, 1, db);
  await expect(reserveReviewAttempt(campaign.id, next, [next.blocks[0].id], 'model', db)).rejects.toThrow('소진');
});

it('accepts long individual blocks without truncation and rejects mismatched document plans', async () => {
  const { snapshot, campaign } = await fixture();
  expect(planReviewBatches({ ...snapshot, blocks: [{ ...snapshot.blocks[0], text: '가'.repeat(20000) }] }, [snapshot.blocks[0].id])).toEqual([[snapshot.blocks[0].id]]);
  const other = await createTheory({ title: '다른 문서', markdown: '다른 문서', contract: { ...EMPTY_CONTRACT } }, db);
  await expect(saveReviewPlan(campaign.id, other, other.blocks.map(b => b.id), db)).rejects.toThrow('버전');
});

it('records expired requests as stopped and refuses late owner results or duplicated completion', async () => {
  const { snapshot, ids, campaign } = await fixture();
  const attempt = await reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db);
  await expect(recoverExpiredAttempt(campaign.id, snapshot, db)).rejects.toThrow('기한');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(attempt.deadlineAt + 1);
  await recoverExpiredAttempt(campaign.id, snapshot, db); clock.mockRestore();
  const saved = (await getCampaign(snapshot.document.id, db))!;
  expect(saved.attempts[0].elapsedMs).toBe(120000);
  const run = (await db.review_runs.toArray())[0]; expect(run.status).toBe('stopped'); expect(run.checkedBlockIds).toEqual([]);
  await expect(finishReviewAttempt(campaign.id, attempt.token, reviewSkeleton(snapshot, 'llm-v1', [ids[0]], 'model'), db)).rejects.toThrow('소유권');
  expect(await db.review_runs.count()).toBe(1);
});

it('rolls back result and ownership atomically on storage failure', async () => {
  const { snapshot, ids, campaign } = await fixture();
  const attempt = await reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db);
  const failure = () => { throw new Error('저장 용량 실패'); };
  db.review_campaigns.hook('updating', failure);
  await expect(finishReviewAttempt(campaign.id, attempt.token, reviewSkeleton(snapshot, 'llm-v1', [ids[0]], 'model'), db)).rejects.toThrow('용량');
  db.review_campaigns.hook('updating').unsubscribe(failure);
  expect(await db.review_runs.count()).toBe(0); expect(activeAttempt((await getCampaign(snapshot.document.id, db))!)?.token).toBe(attempt.token);
});

it('round trips completed ledgers and imports legacy v5 without inherited campaigns', async () => {
  const { snapshot, ids, campaign } = await fixture();
  await saveReviewPlan(campaign.id, snapshot, ids, db);
  const attempt = await reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db);
  const run = reviewSkeleton(snapshot, 'llm-v1', [], 'model'); run.status = 'failed'; run.outcome = 'insufficient';
  await finishReviewAttempt(campaign.id, attempt.token, run, db);
  const bundle = await createWorkspaceBundle(db); await restoreWorkspaceBundle(bundle, target);
  expect(await target.review_campaigns.toArray()).toEqual(bundle.data.reviewCampaigns);
  const { reviewCampaigns: _campaigns, ...legacy } = bundle.data;
  await restoreWorkspaceBundle({ ...bundle, version: 5, data: legacy }, target);
  expect(await target.review_campaigns.count()).toBe(0); expect(await target.review_runs.count()).toBe(1);
});

it('releases backup request ownership without replay and rejects corrupt ledgers before replacement', async () => {
  const { snapshot, ids, campaign } = await fixture();
  await reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db);
  const bundle = await createWorkspaceBundle(db); await restoreWorkspaceBundle(bundle, target);
  const saved = (await target.review_campaigns.toArray())[0];
  expect(activeAttempt(saved)).toBeUndefined(); expect(saved.attempts[0].elapsedMs).toBe(120000);
  expect((await target.review_runs.toArray())[0].status).toBe('stopped');
  const corrupt = structuredClone(bundle); corrupt.data.reviewCampaigns[0].attempts[0].blockIds = ['missing'];
  await expect(restoreWorkspaceBundle(corrupt, target)).rejects.toThrow('캠페인');
  expect((await target.review_campaigns.toArray())[0]).toEqual(saved);
});

function issue(blockId: string, severity: ReviewIssue['severity'] = 'warning'): ReviewIssue {
  return { id: crypto.randomUUID(), kind: 'scope', severity, blockIds: [blockId], quotes: ['가'],
    explanation: '가정 범위를 확인하세요.', resolution: '조건을 명시하세요.', resolvedByRunId: null };
}
function withIssue(run: ReviewRun, candidate: ReviewIssue) { run.issues = [candidate]; run.outcome = 'issues'; return run; }

it('matches kind, source block and normalized quotations without claiming semantic identity', () => {
  const first = { ...issue('a'), blockIds: ['b', 'a'], quotes: [' X\n Y ', 'Ａ'] };
  const reordered = { ...issue('a'), blockIds: ['a', 'b'], quotes: ['A', 'X Y'], explanation: '다른 설명' };
  expect(issueFingerprint(first)).toBe(issueFingerprint(reordered));
  expect(issueFingerprint({ ...reordered, kind: 'argument' })).not.toBe(issueFingerprint(first));
  expect(issueFingerprint({ ...reordered, quotes: ['A', 'X Z'] })).not.toBe(issueFingerprint(first));
});

it('detects repeated and previously resolved candidates but excludes other documents and unselected omissions', async () => {
  const { snapshot, ids } = await fixture();
  const previous = withIssue(reviewSkeleton(snapshot, 'llm-v1', [ids[0]], 'model'), issue(ids[0]));
  previous.issues[0].resolvedByRunId = 'historical-recheck';
  const current = withIssue(reviewSkeleton(snapshot, 'llm-v1', [ids[0]], 'model'), issue(ids[0]));
  expect(runStopReasons(current, [ids[0]], [previous, current])).toEqual(['repeated_issue', 'previously_resolved_issue']);
  expect(runStopReasons(current, [ids[0]], [{ ...previous, documentId: 'other' }, current])).toEqual([]);
  expect(runStopReasons(current, ids, [current])).toContain('insufficient_evidence');
  current.limitations = ['외부 자료 부족']; expect(runStopReasons(current, [ids[0]], [current])).toEqual(['insufficient_evidence']);
});

it('blocks critical results at reservation, requires a grounded resume note and preserves acknowledgements in backups', async () => {
  const { snapshot, ids, campaign } = await fixture();
  const attempt = await reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db);
  const run = withIssue(reviewSkeleton(snapshot, 'llm-v1', [ids[0]], 'model'), issue(ids[0], 'critical'));
  await finishReviewAttempt(campaign.id, attempt.token, run, db);
  await expect(reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db)).rejects.toThrow('중단 사유');
  await changeCampaignBudget(campaign.id, 4, db);
  await expect(reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db)).rejects.toThrow('중단 사유');
  await expect(confirmCampaignResume(campaign.id, run.id, ' ', db)).rejects.toThrow('사유');
  await expect(confirmCampaignResume(campaign.id, 'stale-run', '조건 검토', db)).rejects.toThrow('최신 검토');
  const saved = await confirmCampaignResume(campaign.id, run.id, '조건 수정 후 해당 범위를 다시 검토', db);
  expect(campaignStop(saved, [run])).toBeNull(); expect(saved.attempts).toHaveLength(1);
  expect((await db.review_runs.get(run.id))!.issues[0].resolvedByRunId).toBeNull();
  const bundle = await createWorkspaceBundle(db); await restoreWorkspaceBundle(bundle, target);
  expect((await target.review_campaigns.get(campaign.id))!.confirmations).toEqual(saved.confirmations);
  const bad = structuredClone(bundle); bad.data.reviewCampaigns[0].confirmations![0].reasons = ['review_failure'];
  await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow('캠페인');
  await reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db);
});

it('requires a new confirmation for every repeated result and does not equate confirmed failures with checked scope', async () => {
  const { snapshot, ids, campaign } = await fixture();
  const first = await reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db);
  const warning = withIssue(reviewSkeleton(snapshot, 'llm-v1', [ids[0]], 'model'), issue(ids[0]));
  await finishReviewAttempt(campaign.id, first.token, warning, db);
  const second = await reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db);
  const repeat = withIssue(reviewSkeleton(snapshot, 'llm-v1', [ids[0]], 'model'), issue(ids[0]));
  const saved = await finishReviewAttempt(campaign.id, second.token, repeat, db);
  expect(campaignStop(saved, [warning, repeat])?.reasons).toEqual(['repeated_issue']);
  await expect(reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db)).rejects.toThrow('중단');
  await confirmCampaignResume(campaign.id, repeat.id, '다른 검사 조건으로 재시도', db);
  const third = await reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db);
  const failed = reviewSkeleton(snapshot, 'llm-v1', [], 'model'); failed.status = 'failed'; failed.outcome = 'insufficient';
  const failedLedger = await finishReviewAttempt(campaign.id, third.token, failed, db);
  expect(campaignStop(failedLedger, [warning, repeat, failed])?.reasons).toEqual(['review_failure']);
  await confirmCampaignResume(campaign.id, failed.id, '실패 원인을 확인했으나 검사는 미완료', db);
  expect((await db.review_runs.get(failed.id))!.checkedBlockIds).toEqual([]);
  await expect(reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db)).rejects.toThrow('소진');
});

it('explicitly closes a review without promoting its verdict and starts a fresh budget with archived ownership', async () => {
  const { snapshot, ids, campaign } = await fixture();
  const attempt = await reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db);
  await expect(closeCampaign(campaign.id, snapshot, '미검사 유지', db)).rejects.toThrow('상태');
  const run = reviewSkeleton(snapshot, 'llm-v1', [ids[0]], 'model'); run.outcome = 'insufficient';
  await finishReviewAttempt(campaign.id, attempt.token, run, db);
  const closed = await closeCampaign(campaign.id, snapshot, '미검사와 한계를 남긴 채 이번 검토 종료', db);
  expect(closed.closure?.versionId).toBe(snapshot.version.id);
  expect((await ensureCampaign(snapshot.document.id, db)).id).toBe(closed.id);
  await expect(reserveReviewAttempt(campaign.id, snapshot, [ids[0]], 'model', db)).rejects.toThrow('종료');
  const [a, b] = await Promise.allSettled([startNewCampaign(campaign.id, db), startNewCampaign(campaign.id, db)]);
  expect([a, b].filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const fresh = (await getCampaign(snapshot.document.id, db))!;
  expect(fresh.id).not.toBe(closed.id); expect(fresh.attempts).toEqual([]);
  expect((await db.review_campaigns.get(closed.id))!.activeDocumentId).toBeNull();
  const bundle = await createWorkspaceBundle(db); await restoreWorkspaceBundle(bundle, target);
  expect(await target.review_campaigns.count()).toBe(2);
  expect((await target.review_runs.get(run.id))!.outcome).toBe('insufficient');
});

it('rejects forged closure and confirmation references before modifying the destination', async () => {
  const { snapshot, campaign } = await fixture();
  await closeCampaign(campaign.id, snapshot, '수동 종료', db);
  const bundle = await createWorkspaceBundle(db); await restoreWorkspaceBundle(bundle, target);
  const bad = structuredClone(bundle); bad.data.reviewCampaigns[0].closure!.versionId = 'missing';
  await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow('캠페인');
  expect((await target.review_campaigns.get(campaign.id))!.closure?.note).toBe('수동 종료');
});
