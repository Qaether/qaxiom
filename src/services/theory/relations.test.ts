// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createTheory, saveTheoryVersion } from './documents';
import { EMPTY_CONTRACT } from './types';
import { runLocalReview, setClaimAcceptance } from './reviews';
import { approveRelation, claimAnchor, loadRelationWiki, retractRelation, type RelationProposal } from './relations';
import { anchorKey, COMPATIBILITY_LABELS } from './relationTypes';
import { relationHash } from './relationValidation';
import { relationGraph } from './relationGraph';
import { relationWikiToMarkdown } from './relationReport';
import { importReference } from '../retrieval/references';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`relations-${crypto.randomUUID()}`); target = new QaxiomDatabase(`relations-target-${crypto.randomUUID()}`); });
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); await target.delete(); });
async function fixture() {
  const snapshot = await createTheory({ title: 'Graph theory', markdown: '# 가정\n\nA > 0.\n\n# 결과\n\nB > A.', contract: { ...EMPTY_CONTRACT } }, db);
  const run = await runLocalReview(snapshot, db);
  for (const c of run.claims) { await setClaimAcceptance(run.id, c.id, 'accepted', db); c.acceptance = 'accepted'; }
  const a = claimAnchor(run, run.claims[0].id), b = claimAnchor(run, run.claims[1].id);
  const proposal: RelationProposal = { documentId: snapshot.document.id, from: b, to: a, kind: 'depends_on', dependencyType: 'proof', assessment: null, note: 'B relies on A.' };
  return { snapshot, run, a, b, proposal };
}
async function referenceProposal(proposal: RelationProposal, text: string, role: 'external' | 'note' = 'external') {
  const imported = await importReference('evidence.md', text, role, db);
  const span = (await db.reference_spans.where('sourceId').equals(imported.source.id).first())!;
  return { ...proposal, kind: 'supports' as const, dependencyType: null, to: { type: 'reference' as const, sourceId: imported.source.id,
    sourceHash: imported.source.contentHash, spanId: span.id, spanHash: span.contentHash, quote: span.text },
    assessment: { label: 'compatible' as const, theoryConditions: 'A > 0; same units.', referenceConditions: 'Positive A; same units.' } };
}

it('approves frozen claim dependencies and derives backlinks and modification impact without model calls', async () => {
  const { proposal, a, b, snapshot } = await fixture(); const fetchMock = vi.spyOn(globalThis, 'fetch');
  const relation = await approveRelation(proposal, db); expect(relation.relationHash).toBe(await relationHash(relation));
  const wiki = await loadRelationWiki(snapshot.document.id, db);
  expect(wiki.entries[0].status).toBe('active'); expect(fetchMock).not.toHaveBeenCalled();
  const graph = relationGraph([relation], anchorKey(a)); expect(graph.incoming.map(r => r.id)).toEqual([relation.id]); expect(graph.impacted).toEqual([anchorKey(b)]);
  expect(relationGraph([relation], anchorKey(b)).dependencies).toEqual([anchorKey(a)]);
  const report = relationWikiToMarkdown(wiki); expect(report).toContain(relation.relationHash); expect(report).toContain(a.quote.trim()); expect(report).toContain('정합성 보증이 아닙니다');
});

it('rejects unaccepted, self, fabricated, cross-document and old-version endpoints without writes', async () => {
  const { proposal, snapshot, a, run } = await fixture();
  await expect(approveRelation({ ...proposal, to: proposal.from }, db)).rejects.toThrow('원문');
  await expect(approveRelation({ ...proposal, to: { ...a, quote: 'forged quote' } }, db)).rejects.toThrow('다시 확인');
  const other = await createTheory({ title: 'Other', markdown: 'Other claim.', contract: { ...EMPTY_CONTRACT } }, db);
  await expect(approveRelation({ ...proposal, documentId: other.document.id }, db)).rejects.toThrow('정본');
  await setClaimAcceptance(run.id, a.claimId, 'rejected', db);
  await expect(approveRelation(proposal, db)).rejects.toThrow('채택');
  await setClaimAcceptance(run.id, a.claimId, 'accepted', db);
  await saveTheoryVersion(snapshot.document.id, snapshot.version.id, { title: 'Revised title', markdown: snapshot.version.markdown, contract: snapshot.version.contract }, db);
  await expect(approveRelation(proposal, db)).rejects.toThrow('정본 버전'); expect(await db.research_relations.count()).toBe(0);
});

it('detects only declared proof cycles while allowing concept cycles and bounded dependency traversal', async () => {
  const { proposal, snapshot } = await fixture(); const first = await approveRelation(proposal, db);
  const second = await approveRelation({ ...proposal, from: proposal.to as typeof proposal.from, to: proposal.from }, db);
  expect(relationGraph([first, second], anchorKey(first.from)).proofCycleRelationIds.sort()).toEqual([first.id, second.id].sort());
  const concept = [first, second].map(r => ({ ...r, dependencyType: 'concept' as const }));
  const graph = relationGraph(concept, anchorKey(first.from)); expect(graph.proofCycleRelationIds).toEqual([]); expect(graph.dependencies).toHaveLength(1);
  expect(relationWikiToMarkdown(await loadRelationWiki(snapshot.document.id, db))).toContain(first.id);
});

it('preserves approval history on retraction, hashes its reason and permits a new explicit approval', async () => {
  const { proposal, snapshot } = await fixture(); const relation = await approveRelation(proposal, db);
  await expect(approveRelation(proposal, db)).rejects.toThrow('이미 있습니다');
  await expect(retractRelation(relation.id, '', db)).rejects.toThrow('사유');
  const retracted = await retractRelation(relation.id, 'No longer used.', db);
  expect(retracted.relationHash).not.toBe(relation.relationHash); expect(retracted.relationHash).toBe(await relationHash(retracted));
  await expect(retractRelation(relation.id, 'twice', db)).rejects.toThrow('이미 철회');
  await approveRelation(proposal, db); const wiki = await loadRelationWiki(snapshot.document.id, db);
  expect(wiki.entries.map(e => e.status).sort()).toEqual(['active', 'retracted']); expect(relationWikiToMarkdown(wiki)).toContain('No longer used.');
});

it('removes changed-version and revoked-claim relations from the current graph without silently migrating them', async () => {
  const { proposal, snapshot, run, a } = await fixture(); await approveRelation(proposal, db);
  await setClaimAcceptance(run.id, a.claimId, 'proposed', db);
  expect((await loadRelationWiki(snapshot.document.id, db)).entries[0].status).toBe('claim_unaccepted');
  await setClaimAcceptance(run.id, a.claimId, 'accepted', db);
  await saveTheoryVersion(snapshot.document.id, snapshot.version.id, { title: 'v2', markdown: snapshot.version.markdown, contract: snapshot.version.contract }, db);
  expect((await loadRelationWiki(snapshot.document.id, db)).entries[0].status).toBe('stale'); expect(await db.research_relations.count()).toBe(1);
  await restoreWorkspaceBundle(await createWorkspaceBundle(db), target);
  expect((await loadRelationWiki(snapshot.document.id, target)).entries[0].status).toBe('stale');
});

it('records independent reference conditions/classifications separately and never promotes notes or own snapshots', async () => {
  const { proposal, snapshot } = await fixture();
  const external = await referenceProposal(proposal, 'Independent result under stated conditions.'); await approveRelation(external, db);
  const note = await referenceProposal(proposal, 'My research memo.', 'note'); await approveRelation(note, db);
  const own = await referenceProposal(proposal, snapshot.version.markdown); await approveRelation(own, db);
  let wiki = await loadRelationWiki(snapshot.document.id, db);
  expect(wiki.entries.filter(e => e.independent)).toHaveLength(1);
  await createTheory({ title: 'Own result', markdown: 'Independent result under stated conditions.', contract: { ...EMPTY_CONTRACT } }, db);
  wiki = await loadRelationWiki(snapshot.document.id, db); expect(wiki.entries.every(e => !e.independent)).toBe(true);
  expect(wiki.entries.every(e => e.relation.assessment?.label === 'compatible')).toBe(true); expect(relationWikiToMarkdown(wiki)).toContain('독립 외부 자료: 아니오');
});

it('requires both applicability conditions and accepts all four human-assessed compatibility labels without inference', async () => {
  const { proposal } = await fixture(); const ref = await referenceProposal(proposal, 'A positive result.');
  await expect(approveRelation({ ...ref, assessment: { ...ref.assessment, referenceConditions: '' } }, db)).rejects.toThrow('승인 참조');
  for (const label of COMPATIBILITY_LABELS) {
    const relation = await approveRelation({ ...ref, assessment: { ...ref.assessment, label } }, db);
    expect(relation.assessment?.label).toBe(label); await retractRelation(relation.id, 'Next comparison', db);
  }
});

it('round trips v9 relations and rejects forged quote/hash/foreign references before replacing a workspace', async () => {
  const { proposal } = await fixture(); await approveRelation(await referenceProposal(proposal, 'External claim.'), db);
  const bundle = await createWorkspaceBundle(db); expect(bundle.version).toBe(22); await restoreWorkspaceBundle(bundle, target);
  const original = await target.research_relations.toArray(); expect(original).toEqual(bundle.data.researchRelations);
  const hash = structuredClone(bundle); hash.data.researchRelations[0].note = 'changed after approval';
  await expect(restoreWorkspaceBundle(hash, target)).rejects.toThrow('관계 해시');
  const quote = structuredClone(bundle); quote.data.researchRelations[0].from.quote = 'not in original';
  await expect(restoreWorkspaceBundle(quote, target)).rejects.toThrow('승인 참조');
  const missing = structuredClone(bundle); missing.data.researchRelations[0].from.runId = 'missing';
  await expect(restoreWorkspaceBundle(missing, target)).rejects.toThrow('승인 참조');
  const duplicate = structuredClone(bundle); duplicate.data.researchRelations.push({ ...duplicate.data.researchRelations[0], id: 'another-active-edge' });
  await expect(restoreWorkspaceBundle(duplicate, target)).rejects.toThrow('승인 참조');
  const overflow = structuredClone(bundle);
  overflow.data.researchRelations = Array.from({ length: 1001 }, (_, i) => ({ ...overflow.data.researchRelations[0], id: `historical-${i}`, retractedAt: Date.now(), retractionNote: 'Historical' }));
  await expect(restoreWorkspaceBundle(overflow, target)).rejects.toThrow('승인 참조');
  expect(await target.research_relations.toArray()).toEqual(original);
});

it('rolls back the entire workspace if relation publication fails during restore', async () => {
  const { proposal, snapshot } = await fixture(); await approveRelation(proposal, db);
  await createTheory({ title: 'Preserve me', markdown: 'Original target workspace.', contract: { ...EMPTY_CONTRACT } }, target);
  const before = await createWorkspaceBundle(target), bundle = await createWorkspaceBundle(db);
  vi.spyOn(target.research_relations, 'bulkAdd').mockRejectedValueOnce(new Error('forced relation restore failure'));
  await expect(restoreWorkspaceBundle(bundle, target)).rejects.toThrow('forced');
  expect((await createWorkspaceBundle(target)).data).toEqual(before.data); expect(await target.theory_documents.get(snapshot.document.id)).toBeUndefined();
});

it('imports genuine v8 and migrates populated v8 without fabricating approved relations', async () => {
  const { snapshot } = await fixture(); const bundle = await createWorkspaceBundle(db);
  const { researchRelations: _relations, ...data } = bundle.data;
  await restoreWorkspaceBundle({ ...bundle, version: 8, data }, target); expect(await target.research_relations.count()).toBe(0);
  await target.delete(); const legacy = new Dexie(target.name);
  const tables = db.tables.filter(t => t.name !== 'research_relations');
  legacy.version(8).stores(Object.fromEntries(tables.map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const table of tables) await legacy.table(table.name).bulkAdd(await table.toArray());
  legacy.close(); await target.open(); expect(target.verno).toBe(23);
  expect(await target.document_versions.get(snapshot.version.id)).toEqual(snapshot.version); expect(await target.research_relations.count()).toBe(0);
});

it('refuses source/span or live relation tampering and keeps existing approvals', async () => {
  const { proposal, snapshot } = await fixture(); const ref = await referenceProposal(proposal, 'Original reference.');
  await db.reference_spans.update(ref.to.spanId, { startOffset: 1 });
  await expect(approveRelation(ref, db)).rejects.toThrow('원문 참조'); expect(await db.research_relations.count()).toBe(0);
  const relation = await approveRelation(proposal, db);
  await db.research_relations.update(relation.id, { note: 'unhashed modification' });
  await expect(loadRelationWiki(snapshot.document.id, db)).rejects.toThrow('관계 해시');
});

it('serializes competing identical approvals so only one is published', async () => {
  const { proposal } = await fixture(); const result = await Promise.allSettled([approveRelation(proposal, db), approveRelation(proposal, db)]);
  expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(await db.research_relations.count()).toBe(1);
});
