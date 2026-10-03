// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createTheory, loadTheory, saveTheoryVersion } from './documents';
import { EMPTY_CONTRACT } from './types';
import { importReference } from '../retrieval/references';
import { prepareExternalReview, assertExternalCurrent, parseExternalResponse, externalReviewRequest } from './externalReview';
import { reviewSkeleton, resolveReviewIssue } from './reviews';
import { ensureCampaign, reserveReviewAttempt, finishReviewAttempt, pendingBatches, saveReviewPlan, activeAttempt, recoverExpiredAttempt } from './campaigns';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { registerPdf, processPdf } from '../retrieval/pdfIngestion';
import { reviewToMarkdown } from './reviewReport';
import type { PdfExtractionOptions } from '../retrieval/pdfExtraction';
import { sendChatMessage } from '../llm';
import { DEFAULT_SETTINGS, AVAILABLE_MODELS } from '../../constants';
import { externalAssessmentHash } from './relationValidation';

const provider = vi.hoisted(() => vi.fn());
vi.mock('../providers/gemini', () => ({ streamGemini: provider }));
vi.mock('../providers/openai', () => ({ streamOpenAI: provider }));
vi.mock('../providers/anthropic', () => ({ streamAnthropic: provider }));

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`external-${crypto.randomUUID()}`); target = new QaxiomDatabase(`external-target-${crypto.randomUUID()}`); });
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); await target.delete(); });
async function fixture() {
  const snapshot = await createTheory({ title: '독립 대조', markdown: 'A positive.\n\nPRIVATE unselected theorem.', contract: { ...EMPTY_CONTRACT, assumptions: 'A > 0', scope: 'positive A' } }, db);
  const source = (await importReference('external.md', 'Independent positive result.\n\n' + 'PRIVATE unselected section. '.repeat(180), 'external', db)).source;
  const span = (await db.reference_spans.where('sourceId').equals(source.id).sortBy('position'))[0];
  await importReference('PRIVATE-other.md', 'PRIVATE other document.', 'external', db);
  const inputs = [{ blockId: snapshot.blocks[0].id, spanId: span.id, theoryConditions: 'positive A in theory', referenceConditions: 'measured positive A' }];
  return { snapshot, source, span, inputs, campaign: await ensureCampaign(snapshot.document.id, db) };
}
function response(context: Awaited<ReturnType<typeof prepareExternalReview>>['context'], label: 'compatible' | 'different_scope' | 'conflict_candidate' | 'insufficient_evidence' = 'different_scope') {
  const p = context.pairs[0];
  return { checkedPairIds: [p.id], limitations: [], assessments: [{ pairId: p.id, label, theoryQuote: 'A positive.', referenceQuote: 'Independent positive result.', theoryConditions: 'all positive A', referenceConditions: 'measured positive A', explanation: '조건 차이를 별도로 확인한다.' }] };
}
async function start() {
  const f = await fixture(), prepared = await prepareExternalReview(f.snapshot, f.inputs, db);
  const attempt = await reserveReviewAttempt(f.campaign.id, f.snapshot, prepared.context.blocks.map(b => b.id), 'mock', db, undefined, prepared);
  const run = reviewSkeleton(f.snapshot, 'external-v1', [], 'mock');
  const result = parseExternalResponse(JSON.stringify(response(prepared.context)), prepared.context);
  run.external = { context: prepared.context, checkedPairIds: result.checkedPairIds, assessments: result.assessments };
  run.limitations = ['외부 대조이며 내부 검사는 미수행'];
  return { ...f, prepared, attempt, run };
}

it('freezes selected original pairs/conditions/whole contract and explicit omissions without any provider call or hidden text', async () => {
  const { snapshot, inputs } = await fixture(); const fetchMock = vi.spyOn(globalThis, 'fetch');
  const prepared = await prepareExternalReview(snapshot, inputs, db);
  expect(prepared.request).toContain('Independent positive result.'); expect(prepared.request).toContain('positive A in theory');
  expect(prepared.context.contract).toEqual(snapshot.version.contract); expect(prepared.context.omittedBlockCount).toBe(1);
  expect(prepared.context.omissions[0].omittedSpanCount).toBeGreaterThan(0);
  expect(prepared.request).not.toContain('PRIVATE'); expect(prepared.request).not.toContain('stateSignature'); expect(prepared.request).not.toContain('predecessorIds');
  expect(fetchMock).not.toHaveBeenCalled(); await assertExternalCurrent(snapshot, prepared, db);
});

it('excludes notes, self snapshots and exact canonical reattachments from any workspace document', async () => {
  const { snapshot, inputs } = await fixture();
  const other = await createTheory({ title: '다른 정본', markdown: 'Other canonical theory.', contract: EMPTY_CONTRACT }, db);
  for (const [name, text, role] of [['note.txt', 'User note.', 'note'], ['self.txt', 'Self snapshot.', 'theory_snapshot'], ['copy.txt', other.version.markdown, 'external']] as const) {
    const source = (await importReference(name, text, role, db)).source;
    const span = (await db.reference_spans.where('sourceId').equals(source.id).first())!;
    await expect(prepareExternalReview(snapshot, [{ ...inputs[0], spanId: span.id }], db)).rejects.toThrow('독립');
  }
});

it('requires grounded quoted classifications for exactly the actually checked selected pairs', async () => {
  const { snapshot, inputs } = await fixture(); const { context } = await prepareExternalReview(snapshot, inputs, db);
  for (const label of ['compatible', 'different_scope', 'conflict_candidate', 'insufficient_evidence'] as const) expect(parseExternalResponse(JSON.stringify(response(context, label)), context).assessments[0].label).toBe(label);
  for (const mutate of [
    (r: ReturnType<typeof response>) => { r.assessments[0].referenceQuote = 'invented'; },
    (r: ReturnType<typeof response>) => { r.assessments[0].theoryQuote = 'PRIVATE'; },
    (r: ReturnType<typeof response>) => { r.assessments[0].pairId = 'unselected'; },
    (r: ReturnType<typeof response>) => { r.checkedPairIds = []; },
    (r: ReturnType<typeof response>) => { r.assessments.push(r.assessments[0]); },
    (r: ReturnType<typeof response>) => { r.assessments[0].referenceConditions = ''; }
  ]) { const r = response(context); mutate(r); expect(() => parseExternalResponse(JSON.stringify(r), context)).toThrow(); }
  expect(parseExternalResponse(JSON.stringify({ checkedPairIds: [], assessments: [], limitations: ['미검사'] }), context).checkedPairIds).toEqual([]);
});

it('keeps external claim extraction as a grounded, unaccepted candidate and preserves legacy assessment hashes', async () => {
  const { snapshot, inputs } = await fixture(); const { context } = await prepareExternalReview(snapshot, inputs, db);
  const legacy = parseExternalResponse(JSON.stringify(response(context)), context).assessments[0];
  expect(legacy.referenceClaim).toBeUndefined();
  const oldHash = await externalAssessmentHash(legacy);
  const proposed = { ...response(context), assessments: [{ ...response(context).assessments[0], referenceClaim: {
    statement: 'The source reports a positive result.', evidenceQuote: 'Independent positive result.', kind: 'empirical', basis: 'author_statement', conditions: 'measured positive A'
  } }] };
  const candidate = parseExternalResponse(JSON.stringify(proposed), context).assessments[0];
  expect(candidate.referenceClaim).toEqual(proposed.assessments[0].referenceClaim);
  expect(await externalAssessmentHash(candidate)).not.toBe(oldHash);
  for (const invalid of [
    { ...proposed.assessments[0].referenceClaim, evidenceQuote: 'PRIVATE unselected section.' },
    { ...proposed.assessments[0].referenceClaim, kind: 'verified' },
    { ...proposed.assessments[0].referenceClaim, conditions: '' }
  ]) expect(() => parseExternalResponse(JSON.stringify({ ...proposed, assessments: [{ ...proposed.assessments[0], referenceClaim: invalid }] }), context)).toThrow();
  expect(parseExternalResponse(JSON.stringify({ ...proposed, assessments: [{ ...proposed.assessments[0], referenceClaim: null }] }), context).assessments[0].referenceClaim).toBeUndefined();
  expect(await externalAssessmentHash(legacy)).toBe(oldHash);
});

it('rejects empty/duplicate/oversized selections and mandatory budget overflow without reserving requests', async () => {
  const { snapshot, inputs, campaign } = await fixture();
  await expect(prepareExternalReview(snapshot, [], db)).rejects.toThrow('1–8');
  await expect(prepareExternalReview(snapshot, [inputs[0], inputs[0]], db)).rejects.toThrow();
  await expect(prepareExternalReview(snapshot, [{ ...inputs[0], theoryConditions: '' }], db)).rejects.toThrow();
  await expect(prepareExternalReview(snapshot, Array(9).fill(inputs[0]), db)).rejects.toThrow('1–8');
  const prepared = await prepareExternalReview(snapshot, inputs, db);
  expect(() => externalReviewRequest({ ...prepared.context, contract: { ...prepared.context.contract, scope: '가'.repeat(20000) } })).toThrow('40 KB');
  expect((await db.review_campaigns.get(campaign.id))!.attempts).toEqual([]);
});

it('rejects changed selected source/role and canonical offsets before consuming any request budget', async () => {
  const { snapshot, inputs, source, campaign } = await fixture(); const prepared = await prepareExternalReview(snapshot, inputs, db);
  await db.references.update(source.id, { role: 'note' });
  await expect(reserveReviewAttempt(campaign.id, snapshot, prepared.context.blocks.map(b => b.id), 'mock', db, undefined, prepared)).rejects.toThrow();
  expect((await db.review_campaigns.get(campaign.id))!.attempts).toEqual([]);
  await db.references.update(source.id, { role: 'external' });
  await db.document_blocks.update([snapshot.version.id, snapshot.blocks[0].id], { startOffset: 1 });
  await expect(prepareExternalReview(await loadTheory(snapshot.document.id, db), inputs, db)).rejects.toThrow('위치');
});

it('consumes the shared lease/budget but never advances an internal split plan or closes its issue', async () => {
  const f = await start();
  const parallel = new QaxiomDatabase(db.name);
  try { await expect(reserveReviewAttempt(f.campaign.id, f.snapshot, f.prepared.context.blocks.map(b => b.id), 'mock', parallel, undefined, f.prepared)).rejects.toThrow('진행'); } finally { parallel.close(); }
  await finishReviewAttempt(f.campaign.id, f.attempt.token, f.run, db);
  const planned = await saveReviewPlan(f.campaign.id, f.snapshot, f.snapshot.blocks.map(b => b.id), db);
  expect(planned.attempts).toHaveLength(1); expect(f.run.checkedBlockIds).toEqual([]); expect(pendingBatches(planned, [f.run]).flat()).toEqual(f.snapshot.blocks.map(b => b.id));
  expect(reviewToMarkdown(f.run, f.snapshot.version, f.snapshot.blocks)).toContain('독립 외부 원문 대조');
  await expect(resolveReviewIssue(f.run.id, 'missing', f.run.id, db)).rejects.toThrow();
});

it('does not publish checked external pairs when selected source or theory changes during transmission', async () => {
  const f = await start(); await db.references.update(f.source.id, { name: 'changed-name.md' });
  await finishReviewAttempt(f.campaign.id, f.attempt.token, f.run, db);
  expect(f.run.status).toBe('failed'); expect(f.run.external!.checkedPairIds).toEqual([]); expect(f.run.external!.assessments).toEqual([]);
  expect((await db.review_campaigns.get(f.campaign.id))!.attempts[0].runId).toBe(f.run.id);
});

it('drops external classifications on deadline and rolls back result/ownership on quota failure', async () => {
  const f = await start(); const fail = () => { throw new Error('quota'); }; db.review_campaigns.hook('updating', fail);
  await expect(finishReviewAttempt(f.campaign.id, f.attempt.token, f.run, db)).rejects.toThrow('quota');
  db.review_campaigns.hook('updating').unsubscribe(fail); expect(await db.review_runs.count()).toBe(0);
  expect(activeAttempt((await db.review_campaigns.get(f.campaign.id))!)!.token).toBe(f.attempt.token);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(f.attempt.deadlineAt + 1);
  await finishReviewAttempt(f.campaign.id, f.attempt.token, f.run, db); clock.mockRestore();
  expect(f.run.status).toBe('stopped'); expect(f.run.external!.assessments).toEqual([]);
});

it('restores frozen external results and rejects quote/context hash/own-origin tampering atomically', async () => {
  const f = await start(); await finishReviewAttempt(f.campaign.id, f.attempt.token, f.run, db);
  const bundle = await createWorkspaceBundle(db); expect(bundle.version).toBe(22); await restoreWorkspaceBundle(JSON.parse(JSON.stringify(bundle)), target);
  expect((await target.review_runs.get(f.run.id))!.external).toEqual(f.run.external);
  for (const mutate of [
    (b: typeof bundle) => { b.data.reviewRuns[0].external!.context.contextHash = '0'.repeat(64); },
    (b: typeof bundle) => { b.data.reviewRuns[0].external!.assessments[0].referenceQuote = 'invented'; },
    (b: typeof bundle) => { b.data.reviewRuns[0].external!.context.evidence[0].role = 'note'; }
  ]) { const bad = structuredClone(bundle); mutate(bad); await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow(); expect((await target.review_runs.get(f.run.id))!.external).toEqual(f.run.external); }
});

it('restores extracted external claim candidates but rejects a forged source quote before replacing the workspace', async () => {
  const f = await start();
  const extracted = { ...response(f.prepared.context), assessments: [{ ...response(f.prepared.context).assessments[0], referenceClaim: {
    statement: 'Positive measured result', evidenceQuote: 'Independent positive result.', kind: 'empirical', basis: 'author_statement', conditions: 'measured A'
  } }] };
  f.run.external!.assessments = parseExternalResponse(JSON.stringify(extracted), f.prepared.context).assessments;
  await finishReviewAttempt(f.campaign.id, f.attempt.token, f.run, db);
  const bundle = await createWorkspaceBundle(db);
  await restoreWorkspaceBundle(bundle, target);
  expect((await target.review_runs.get(f.run.id))!.external!.assessments[0].referenceClaim?.statement).toBe('Positive measured result');
  const forged = structuredClone(bundle);
  forged.data.reviewRuns[0].external!.assessments[0].referenceClaim!.evidenceQuote = 'PRIVATE unselected section.';
  await expect(restoreWorkspaceBundle(forged, target)).rejects.toThrow();
  expect((await target.review_runs.get(f.run.id))!.external!.assessments[0].referenceClaim?.statement).toBe('Positive measured result');
});

it('restores in-flight external requests as stopped without replay or inherited ownership', async () => {
  const f = await start(); const fetchMock = vi.spyOn(globalThis, 'fetch'); const bundle = await createWorkspaceBundle(db);
  await restoreWorkspaceBundle(bundle, target); const c = (await target.review_campaigns.get(f.campaign.id))!;
  expect(activeAttempt(c)).toBeUndefined(); expect(c.attempts[0].elapsedMs).toBe(120000);
  expect((await target.review_runs.get(c.attempts[0].runId!))!.external!.checkedPairIds).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled(); await restoreWorkspaceBundle(await createWorkspaceBundle(target), db);
});

it('recovers expired external leases and keeps version changes from silently reusing old previews', async () => {
  const f = await start(); const clock = vi.spyOn(Date, 'now').mockReturnValue(f.attempt.deadlineAt + 1);
  await recoverExpiredAttempt(f.campaign.id, f.snapshot, db); clock.mockRestore();
  expect((await db.review_runs.toArray())[0].checker).toBe('external-v1');
  await saveTheoryVersion(f.snapshot.document.id, f.snapshot.version.id, { title: 'v2', markdown: 'changed theory', contract: f.snapshot.version.contract }, db);
  await expect(assertExternalCurrent(f.snapshot, f.prepared, db)).rejects.toThrow();
});

it('preserves PDF pages/empty page exclusions without serializing original bytes into model input', async () => {
  const { snapshot } = await fixture();
  const pdf = await registerPdf('partial.pdf', new TextEncoder().encode('%PDF original PRIVATE byte marker').buffer, 'external', db);
  await processPdf(pdf.asset.id, new AbortController().signal, () => {}, db, async (_bytes: ArrayBuffer, options: PdfExtractionOptions) => {
    await options.onDocument(2, 'fixture-v1', true); await options.onPage({ number: 1, text: 'Independent positive result.' }); await options.onPage({ number: 2, text: '' });
  });
  const span = (await db.reference_spans.where('sourceId').equals(`pdf-${pdf.asset.id}`).first())!;
  const prepared = await prepareExternalReview(snapshot, [{ blockId: snapshot.blocks[0].id, spanId: span.id, theoryConditions: 'A > 0', referenceConditions: 'partial PDF result' }], db);
  expect(prepared.context.evidence[0].pdf!.emptyPages).toEqual([2]); expect(prepared.context.evidence[0].span.page).toBe(1);
  expect(prepared.request).not.toContain('PRIVATE byte marker'); expect(prepared.request).not.toContain('base64'); expect(prepared.request).not.toContain('assetId');
});

it('imports genuine v14 ledgers and upgrades populated v14 without fabricating external checks', async () => {
  const { snapshot } = await fixture(); const bundle = await createWorkspaceBundle(db);
  await restoreWorkspaceBundle({ ...bundle, version: 14 }, target); expect(await target.review_runs.count()).toBe(0);
  await target.delete(); const legacy = new Dexie(target.name);
  legacy.version(14).stores(Object.fromEntries(db.tables.map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const t of db.tables) await legacy.table(t.name).bulkAdd(await t.toArray());
  legacy.close(); await target.open(); expect(target.verno).toBe(23); expect(await target.document_versions.get(snapshot.version.id)).toEqual(snapshot.version);
});

it('routes the same approved selected-pair request to all three existing provider adapters without extra conversation or real network calls', async () => {
  const { snapshot, inputs } = await fixture(); const prepared = await prepareExternalReview(snapshot, inputs, db);
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  const settings = { ...DEFAULT_SETTINGS, apiKeys: { ...DEFAULT_SETTINGS.apiKeys, gemini: 'fake', openai: 'fake', anthropic: 'fake' } };
  for (const name of ['gemini', 'openai', 'anthropic']) {
    provider.mockClear();
    provider.mockImplementation(async (...args: unknown[]) => { const callbacks = args.find(a => !!a && typeof a === 'object' && 'onFinish' in a) as { onFinish: () => void }; callbacks.onFinish(); });
    const model = AVAILABLE_MODELS.find(m => m.provider === name)!;
    const onFinish = vi.fn(), onError = vi.fn();
    await sendChatMessage([{ id: 'selected-pairs', role: 'user', content: prepared.request, timestamp: 0 }], model.id, 'peer_review', settings, { onChunk: () => {}, onFinish, onError });
    expect(provider).toHaveBeenCalledTimes(1); expect(provider.mock.calls[0][0]).toHaveLength(1);
    expect(provider.mock.calls[0][0][0].content).toBe(prepared.request); expect(provider.mock.calls[0][1].provider).toBe(name);
    expect(onFinish).toHaveBeenCalledTimes(1); expect(onError).not.toHaveBeenCalled();
  }
  expect(fetchMock).not.toHaveBeenCalled();
});
