// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createTheory } from './documents';
import { EMPTY_CONTRACT } from './types';
import { importReference } from '../retrieval/references';
import { saveProjectSources } from './projectSources';
import { assertExternalCurrent, prepareExternalReview, parseExternalResponse } from './externalReview';
import { ensureCampaign, finishReviewAttempt, reserveReviewAttempt } from './campaigns';
import { reviewSkeleton } from './reviews';
import { moveTheoryProject } from './projects';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`policy-${crypto.randomUUID()}`); target = new QaxiomDatabase(`policy-target-${crypto.randomUUID()}`); });
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); await target.delete(); });
async function fixture() {
  const snapshot = await createTheory({ title: 'policy', markdown: 'Theory original.', contract: EMPTY_CONTRACT }, db);
  const a = (await importReference('a.md', 'Independent original.', 'external', db)).source;
  const b = (await importReference('PRIVATE.md', 'PRIVATE unselected.', 'external', db)).source;
  const span = (await db.reference_spans.where('sourceId').equals(a.id).first())!;
  const input = [{ blockId: snapshot.blocks[0].id, spanId: span.id, theoryConditions: 'theory', referenceConditions: 'reference' }];
  return { snapshot, a, b, input, campaign: await ensureCampaign(snapshot.document.id, db) };
}
it('preserves explicit legacy selection, restricts configured sources and sends no unselected policy source IDs', async () => {
  const f = await fixture(); const fetchMock = vi.spyOn(globalThis, 'fetch');
  expect((await prepareExternalReview(f.snapshot, f.input, db)).context.projectScope!.policyRevision).toBeNull();
  await saveProjectSources(f.snapshot, null, [f.a.id, f.b.id], db);
  const prepared = await prepareExternalReview(f.snapshot, f.input, db);
  expect(prepared.context.projectScope!.policyRevision).toBe(1); expect(prepared.context.projectScope!.policyHash).toMatch(/^[a-f0-9]{64}$/);
  expect(prepared.request).not.toContain(f.b.id); expect(prepared.request).not.toContain('PRIVATE'); expect(fetchMock).not.toHaveBeenCalled();
  await saveProjectSources(f.snapshot, 1, [f.b.id], db);
  await expect(prepareExternalReview(f.snapshot, f.input, db)).rejects.toThrow('허용 목록');
});
it('blocks empty lists before reservation without charging or automatically broadening scope', async () => {
  const f = await fixture(), prepared = await prepareExternalReview(f.snapshot, f.input, db);
  await saveProjectSources(f.snapshot, null, [], db);
  await expect(reserveReviewAttempt(f.campaign.id, f.snapshot, [f.snapshot.blocks[0].id], 'mock', db, undefined, prepared)).rejects.toThrow('허용 목록');
  expect((await db.review_campaigns.get(f.campaign.id))!.attempts).toEqual([]);
});
it('invalidates previews even when a new policy still permits the selected original', async () => {
  const f = await fixture(), prepared = await prepareExternalReview(f.snapshot, f.input, db);
  await saveProjectSources(f.snapshot, null, [f.a.id], db);
  await expect(assertExternalCurrent(f.snapshot, prepared, db)).rejects.toThrow('변경');
});
it('stores changed in-flight policy as failed with zero actual pairs', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id], db);
  const prepared = await prepareExternalReview(f.snapshot, f.input, db);
  const attempt = await reserveReviewAttempt(f.campaign.id, f.snapshot, [f.snapshot.blocks[0].id], 'mock', db, undefined, prepared);
  const pairId = prepared.context.pairs[0].id;
  const parsed = parseExternalResponse(JSON.stringify({ checkedPairIds: [pairId], limitations: [], assessments: [{ pairId, label: 'compatible', theoryQuote: 'Theory original.', referenceQuote: 'Independent original.', theoryConditions: 'theory', referenceConditions: 'reference', explanation: 'user must check' }] }), prepared.context);
  const run = reviewSkeleton(f.snapshot, 'external-v1', [], 'mock'); run.external = { context: prepared.context, checkedPairIds: parsed.checkedPairIds, assessments: parsed.assessments };
  await saveProjectSources(f.snapshot, 1, [], db);
  await finishReviewAttempt(f.campaign.id, attempt.token, run, db);
  const saved = (await db.review_runs.get(run.id))!; expect(saved.status).toBe('failed'); expect(saved.external!.checkedPairIds).toEqual([]);
});
it('inherits restrictions on split and invalidates old document-project previews', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id], db);
  const prepared = await prepareExternalReview(f.snapshot, f.input, db);
  const split = await moveTheoryProject(f.snapshot, { newTitle: 'split' }, db);
  expect((await db.projects.get(split.document.projectId))!.sourcePolicy!.allowedSourceIds).toEqual([f.a.id]);
  await expect(assertExternalCurrent(f.snapshot, prepared, db)).rejects.toThrow('변경');
  await expect(prepareExternalReview(f.snapshot, f.input, db)).rejects.toThrow('프로젝트');
});
it('rejects stale revisions, duplicate/missing sources and rolls back quota failure', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id], db);
  await expect(saveProjectSources(f.snapshot, null, [], db)).rejects.toThrow('변경');
  await expect(saveProjectSources(f.snapshot, 1, [f.a.id, f.a.id], db)).rejects.toThrow('정책');
  await expect(saveProjectSources(f.snapshot, 1, ['missing'], db)).rejects.toThrow('원문');
  const fail = () => { throw new Error('quota'); }; db.projects.hook('updating', fail);
  await expect(saveProjectSources(f.snapshot, 1, [], db)).rejects.toThrow('quota'); db.projects.hook('updating').unsubscribe(fail);
  expect((await db.projects.get(f.snapshot.document.projectId))!.sourcePolicy!.revision).toBe(1);
});
it('roundtrips policies and frozen request metadata and rejects broken references before atomic restore', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id], db);
  const bundle = await createWorkspaceBundle(db); expect(bundle.version).toBe(22); await restoreWorkspaceBundle(JSON.parse(JSON.stringify(bundle)), target);
  expect((await target.projects.get(f.snapshot.document.projectId))!.sourcePolicy!.allowedSourceIds).toEqual([f.a.id]);
  const bad = structuredClone(bundle); bad.data.projects[0].sourcePolicy!.allowedSourceIds = ['missing'];
  await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow('허용 자료'); expect(await target.references.count()).toBe(2);
});
it('upgrades populated v16 schemas and backups without silently configuring policies', async () => {
  const f = await fixture(), bundle = await createWorkspaceBundle(db);
  await restoreWorkspaceBundle({ ...bundle, version: 16 }, target); expect((await target.projects.get(f.snapshot.document.projectId))!.sourcePolicy).toBeUndefined();
  await target.delete(); const legacy = new Dexie(target.name);
  legacy.version(16).stores(Object.fromEntries(db.tables.map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const t of db.tables) await legacy.table(t.name).bulkAdd(await t.toArray()); legacy.close(); await target.open();
  expect(target.verno).toBe(23); expect((await target.projects.get(f.snapshot.document.projectId))!.sourcePolicy).toBeUndefined();
});
