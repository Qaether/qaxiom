// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createTheory, loadTheory, saveTheoryVersion } from './documents';
import { EMPTY_CONTRACT } from './types';
import { applyTheoryPatch, parseModelReview, prepareReviewRequest, runLocalReview, setClaimAcceptance, storeReview, resolveReviewIssue } from './reviews';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { reviewToMarkdown } from './reviewReport';

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`reviews-${crypto.randomUUID()}`); target = new QaxiomDatabase(`review-target-${crypto.randomUUID()}`); });
afterEach(async () => { await db.delete(); await target.delete(); });
async function fixture() {
  const snapshot = await createTheory({ title: '조건부 이론', markdown: '# 가정\n\nx > 0\n\n# 정리\n\n모든 실수의 log(x)는 정의된다.\n', contract: { ...EMPTY_CONTRACT, assumptions: 'x > 0', scope: '양수 실수' } }, db);
  const block = snapshot.blocks.at(-1)!;
  const output = { checkedBlockIds: snapshot.blocks.map(block => block.id), limitations: [],
    claims: [{ blockId: block.id, quote: '모든 실수', kind: 'theorem' }],
    issues: [{ kind: 'scope', severity: 'critical', blockIds: [block.id], quotes: ['모든 실수'],
      explanation: '양수 범위 가정을 벗어났습니다.', resolution: 'x > 0 범위로 제한하세요.',
      patch: { blockId: block.id, replacement: 'x > 0인 실수의 log(x)는 정의된다.\n', introducedAssumptions: '실수 로그의 정의역은 x > 0이다.' } }] };
  const run = parseModelReview(JSON.stringify(output), snapshot, snapshot.blocks.map(block => block.id), 'test-model');
  return { snapshot, block, output, run };
}

it('migrates populated v4 without altering canonical documents and references', async () => {
  const { snapshot } = await fixture();
  const legacy = new Dexie(target.name);
  const tables = db.tables.filter(table => !['review_runs', 'review_campaigns', 'embedding_spaces', 'embedding_vectors', 'embedding_manifests', 'embedding_activations', 'research_relations'].includes(table.name));
  legacy.version(4).stores(Object.fromEntries(tables.map(table => [table.name, [table.schema.primKey.src, ...table.schema.indexes.map(index => index.src)].join(',')])));
  for (const table of tables) await legacy.table(table.name).bulkAdd(await db.table(table.name).toArray());
  legacy.close(); await target.open();
  expect(target.verno).toBe(23);
  expect((await loadTheory(snapshot.document.id, target)).version).toEqual(snapshot.version);
  expect(await target.review_runs.count()).toBe(0);
});

it('separates local structural checks and proposed claims from semantic correctness', async () => {
  const snapshot = await createTheory({ title: '참조', markdown: '# 가정\n\nx > 0\n\n# 정리\n\n[[block:missing]] 결과', contract: { ...EMPTY_CONTRACT } }, db);
  const run = await runLocalReview(snapshot, db);
  expect(run.issues.some(issue => issue.kind === 'broken_reference')).toBe(true);
  expect(run.issues.filter(issue => issue.kind === 'missing_contract')).toHaveLength(6);
  expect(run.claims.map(claim => claim.kind)).toEqual(['assumption', 'theorem']);
  expect(run.claims.every(claim => claim.acceptance === 'proposed')).toBe(true);
  await setClaimAcceptance(run.id, run.claims[0].id, 'accepted', db);
  expect((await db.review_runs.get(run.id))!.claims[0].acceptance).toBe('accepted');
  expect(run.limitations[0]).toContain('논증');
});

it('previews selected blocks and complete criteria, and rejects oversized requests without truncation', async () => {
  const { snapshot, block } = await fixture();
  const request = prepareReviewRequest(snapshot, [block.id]);
  expect(request).toContain(snapshot.version.contract.scope);
  const payload = JSON.parse(request.split('원문이다:\n')[1]);
  expect(payload.blocks.map((block: { id: string }) => block.id)).toEqual([block.id]);
  expect(payload.omittedBlockIds).toHaveLength(3);
  expect(() => prepareReviewRequest(snapshot, [])).toThrow('선택');
  expect(() => prepareReviewRequest({ ...snapshot, version: { ...snapshot.version, contract: { ...EMPTY_CONTRACT, assumptions: '가'.repeat(20000) } } }, [block.id])).toThrow('40 KB');
});

it('rejects hallucinated quotations, unselected evidence, unsupported kinds and false complete coverage', async () => {
  const { snapshot, block, output } = await fixture();
  const selected = snapshot.blocks.map(block => block.id);
  for (const edit of [
    (copy: typeof output) => { copy.issues[0].quotes[0] = 'invented'; },
    (copy: typeof output) => { copy.claims[0].kind = 'verified'; },
    (copy: typeof output) => { copy.checkedBlockIds.push('missing'); },
    (copy: typeof output) => { copy.issues[0].patch.blockId = snapshot.blocks[0].id; }
  ]) {
    const copy = structuredClone(output); edit(copy);
    expect(() => parseModelReview(JSON.stringify(copy), snapshot, selected, 'test')).toThrow();
  }
  expect(() => parseModelReview(JSON.stringify(output), snapshot, [block.id], 'test')).toThrow();
  const partial = parseModelReview(JSON.stringify({ checkedBlockIds: [block.id], claims: [], issues: [], limitations: [] }), snapshot, [block.id], 'test');
  expect(partial.outcome).toBe('insufficient'); expect(partial.uncheckedBlockIds).toHaveLength(3);
  const uncertain = parseModelReview(JSON.stringify({ checkedBlockIds: selected, claims: [], issues: [], limitations: ['증명 불충분'] }), snapshot, selected, 'test');
  expect(uncertain.outcome).toBe('insufficient');
});

it('atomically approves one patch, records new assumptions and preserves historical checks for reinspection', async () => {
  const { snapshot, run } = await fixture(); await storeReview(run, db);
  const saved = await applyTheoryPatch(run.id, run.patches[0].id, db);
  expect(saved.version.number).toBe(2);
  expect(saved.version.markdown).toContain('x > 0인 실수');
  expect(saved.version.contract.assumptions).toContain('[승인한 수정의 새 가정]');
  expect((await db.review_runs.get(run.id))!.patches[0].appliedVersionId).toBe(saved.version.id);
  expect(run.versionId).toBe(snapshot.version.id);
  const report = reviewToMarkdown((await db.review_runs.get(run.id))!, snapshot.version, snapshot.blocks);
  expect(report).toContain('해결 조건'); expect(report).toContain('모든 실수'); expect(report).toContain(saved.version.id);
  await expect(applyTheoryPatch(run.id, run.patches[0].id, db)).rejects.toThrow('이미 적용');
  const rechecked = await runLocalReview(saved, db);
  expect(rechecked.versionId).toBe(saved.version.id);
  expect(await db.review_runs.count()).toBe(2);
});

it('rejects stale patches and rolls back both new version and approval on storage failure', async () => {
  const { snapshot, run } = await fixture(); await storeReview(run, db);
  const failure = () => { throw new Error('quota'); };
  db.review_runs.hook('updating', failure);
  await expect(applyTheoryPatch(run.id, run.patches[0].id, db)).rejects.toThrow('quota');
  expect((await loadTheory(snapshot.document.id, db)).version.number).toBe(1);
  expect(await db.document_versions.count()).toBe(1);
  db.review_runs.hook('updating').unsubscribe(failure);
  await saveTheoryVersion(snapshot.document.id, snapshot.version.id, { title: '다른 수정', markdown: '새 내용', contract: snapshot.version.contract }, db);
  await expect(applyTheoryPatch(run.id, run.patches[0].id, db)).rejects.toThrow('오래된');
});

it('restores review/claim/issue/patch references and genuine v4 data, refusing corruption before replacement', async () => {
  const { run } = await fixture(); await storeReview(run, db);
  await applyTheoryPatch(run.id, run.patches[0].id, db);
  const backup = await createWorkspaceBundle(db);
  expect(backup.version).toBe(22);
  await restoreWorkspaceBundle(JSON.parse(JSON.stringify(backup)), target);
  expect((await createWorkspaceBundle(target)).data).toEqual(backup.data);
  const invalid = structuredClone(backup); invalid.data.reviewRuns[0].patches[0].beforeHash = 'changed';
  await expect(restoreWorkspaceBundle(invalid, target)).rejects.toThrow('검토');
  expect(await target.review_runs.count()).toBe(1);
  const invalidQuote = structuredClone(backup); invalidQuote.data.reviewRuns[0].issues[0].quotes[0] = 'invented';
  await expect(restoreWorkspaceBundle(invalidQuote, target)).rejects.toThrow();
  const { reviewRuns: _r, ...v4 } = backup.data;
  await restoreWorkspaceBundle({ ...backup, version: 4, data: v4 }, target);
  expect(await target.review_runs.count()).toBe(0);
  expect(await target.document_versions.count()).toBe(2);
});

it('only lets a user close a historical issue after the same checker passes the current descendant version', async () => {
  const { snapshot, run } = await fixture(); await storeReview(run, db);
  await expect(resolveReviewIssue(run.id, run.issues[0].id, run.id, db)).rejects.toThrow('재검사');
  const saved = await applyTheoryPatch(run.id, run.patches[0].id, db);
  const local = await runLocalReview(saved, db);
  await expect(resolveReviewIssue(run.id, run.issues[0].id, local.id, db)).rejects.toThrow('같은 종류');
  const recheck = parseModelReview(JSON.stringify({ checkedBlockIds: saved.blocks.map(block => block.id), limitations: [], claims: [], issues: [] }), saved, saved.blocks.map(block => block.id), 'test-model');
  await storeReview(recheck, db);
  await resolveReviewIssue(run.id, run.issues[0].id, recheck.id, db);
  expect((await db.review_runs.get(run.id))!.issues[0].resolvedByRunId).toBe(recheck.id);
  const backup = await createWorkspaceBundle(db);
  await restoreWorkspaceBundle(JSON.parse(JSON.stringify(backup)), target);
  const badResolution = structuredClone(backup);
  badResolution.data.reviewRuns.find(candidate => candidate.id === run.id)!.issues[0].resolvedByRunId = local.id;
  await expect(restoreWorkspaceBundle(badResolution, target)).rejects.toThrow('검토');
  expect((await target.review_runs.get(run.id))!.issues[0].resolvedByRunId).toBe(recheck.id);
  expect(snapshot.version.id).not.toBe(recheck.versionId);
});

it('blocks a proposal that oscillates back to a previous document body', async () => {
  const { snapshot, run } = await fixture(); await storeReview(run, db);
  const saved = await applyTheoryPatch(run.id, run.patches[0].id, db);
  const block = saved.blocks.at(-1)!;
  const backwards = parseModelReview(JSON.stringify({ checkedBlockIds: saved.blocks.map(block => block.id), limitations: [], claims: [],
    issues: [{ kind: 'argument', severity: 'warning', blockIds: [block.id], quotes: ['x > 0인 실수'], explanation: '이전 주장 복구 후보', resolution: '본문 재검토',
      patch: { blockId: block.id, replacement: snapshot.blocks.at(-1)!.text, introducedAssumptions: '' } }] }), saved, saved.blocks.map(block => block.id), 'test');
  await storeReview(backwards, db);
  await expect(applyTheoryPatch(backwards.id, backwards.patches[0].id, db)).rejects.toThrow('진동');
  expect((await loadTheory(snapshot.document.id, db)).version.number).toBe(2);
});
