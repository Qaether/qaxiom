// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { QaxiomDatabase } from '../database';
import { createTheory, saveTheoryVersion } from '../theory/documents';
import { EMPTY_CONTRACT } from '../theory/types';
import { runLocalReview, setClaimAcceptance } from '../theory/reviews';
import { approveRelation, claimAnchor, retractRelation } from '../theory/relations';
import { importReference } from './references';
import { searchCanonicalBlocks } from './canonicalRanking';
import { describeCanonicalCandidates } from './canonicalCandidates';
import * as graphService from './graphContext';

let db: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`canonical-candidates-${crypto.randomUUID()}`); });
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); });
async function fixture(premise = 'A > 0.') {
  const snapshot = await createTheory({ title: 'Chosen', markdown: `# 가정\n\n${premise}\n\n# 결과\n\nneedle result B.\n\n# 다른 범위\n\nUnrelated C.`, contract: { ...EMPTY_CONTRACT } }, db);
  const run = await runLocalReview(snapshot, db);
  for (const c of run.claims) { await setClaimAcceptance(run.id, c.id, 'accepted', db); c.acceptance = 'accepted'; }
  const [a, b, c] = run.claims.map(c => claimAnchor(run, c.id));
  const relation = await approveRelation({ documentId: snapshot.document.id, from: b, to: a, kind: 'depends_on', dependencyType: 'proof', assessment: null, note: 'B needs A' }, db);
  await approveRelation({ documentId: snapshot.document.id, from: c, to: b, kind: 'supports', dependencyType: null, assessment: null, note: 'C supports B but is not a mandatory premise' }, db);
  return { snapshot, run, a, b, relation };
}
it('ranks only chosen canonical blocks and annotates mandatory approved dependencies without API calls', async () => {
  const { snapshot, a, b } = await fixture(); const fetchMock = vi.spyOn(globalThis, 'fetch');
  await createTheory({ title: 'Other', markdown: 'needle needle PRIVATE_OTHER_DOC', contract: { ...EMPTY_CONTRACT } }, db);
  await importReference('private.txt', 'needle PRIVATE_REFERENCE', 'external', db);
  const hits = searchCanonicalBlocks(snapshot.blocks, 'ＮＥＥＤＬＥ'); expect(hits.map(h => h.blockId)).toEqual([b.blockId]);
  const candidates = await describeCanonicalCandidates(snapshot, hits, db);
  expect(candidates[0].premiseBlockIds).toEqual([a.blockId]); expect(candidates[0].relationCount).toBe(1);
  expect(candidates[0].block.text).toContain('needle'); expect(JSON.stringify(candidates)).not.toContain('PRIVATE'); expect(fetchMock).not.toHaveBeenCalled();
});
it('returns no matches, stable position ties and at most twelve explicit candidates', async () => {
  const { snapshot } = await fixture(); expect(searchCanonicalBlocks(snapshot.blocks, 'absent_token')).toEqual([]);
  expect(await describeCanonicalCandidates(snapshot, [], db)).toEqual([]);
  const template = snapshot.blocks[1]; const blocks = Array.from({ length: 25 }, (_, i) => ({ ...template, id: `b${i}`, position: 24 - i, text: 'needle' }));
  expect(searchCanonicalBlocks(blocks, 'needle').map(h => h.blockId)).toEqual(Array.from({ length: 12 }, (_, i) => `b${24 - i}`));
  expect(searchCanonicalBlocks([{ ...template, text: '연구지원 도구의 정합성' }], '연구지원을')).toHaveLength(1);
});
it('follows transitive declared definitions and terminates concept cycles without claiming a proof cycle', async () => {
  const { snapshot, run, a, b } = await fixture(); const c = claimAnchor(run, run.claims[2].id);
  await approveRelation({ documentId: snapshot.document.id, from: a, to: c, kind: 'defines', dependencyType: null, assessment: null, note: 'A uses C definition' }, db);
  await approveRelation({ documentId: snapshot.document.id, from: c, to: b, kind: 'depends_on', dependencyType: 'concept', assessment: null, note: 'Concept cycle is declared, not proof' }, db);
  const candidate = (await describeCanonicalCandidates(snapshot, searchCanonicalBlocks(snapshot.blocks, 'needle'), db))[0];
  expect(candidate.premiseBlockIds).toEqual([a.blockId, c.blockId]); expect(candidate.relationCount).toBe(4); expect(candidate.proofCycleCount).toBe(0);
});
it('excludes revoked claims and retracted relations rather than fabricating premises', async () => {
  const { snapshot, run, a, relation } = await fixture(); const hits = searchCanonicalBlocks(snapshot.blocks, 'needle');
  await setClaimAcceptance(run.id, a.claimId, 'rejected', db);
  expect((await describeCanonicalCandidates(snapshot, hits, db))[0].premiseBlockIds).toEqual([]);
  await setClaimAcceptance(run.id, a.claimId, 'accepted', db); await retractRelation(relation.id, 'No longer a premise', db);
  expect((await describeCanonicalCandidates(snapshot, hits, db))[0].relationCount).toBe(0);
});
it('keeps proof cycles visible as declared candidates and excludes external relation content', async () => {
  const { snapshot, a, b } = await fixture();
  await approveRelation({ documentId: snapshot.document.id, from: a, to: b, kind: 'depends_on', dependencyType: 'proof', assessment: null, note: 'Reverse declared edge' }, db);
  const ref = (await importReference('PRIVATE-name.md', 'PRIVATE external quote', 'external', db)).source;
  const span = (await db.reference_spans.where('sourceId').equals(ref.id).first())!;
  await approveRelation({ documentId: snapshot.document.id, from: b, to: { type: 'reference', sourceId: ref.id, sourceHash: ref.contentHash, spanId: span.id, spanHash: span.contentHash, quote: span.text }, kind: 'supports', dependencyType: null, assessment: { label: 'different_scope', theoryConditions: 'PRIVATE condition', referenceConditions: 'PRIVATE external' }, note: 'PRIVATE note' }, db);
  const candidates = await describeCanonicalCandidates(snapshot, searchCanonicalBlocks(snapshot.blocks, 'needle'), db);
  expect(candidates[0].proofCycleCount).toBe(2); expect(candidates[0].excludedExternalCount).toBe(1); expect(JSON.stringify(candidates)).not.toContain('PRIVATE');
});
it('includes long mandatory premises without an artificial review cap', async () => {
  const { snapshot } = await fixture('A ' + 'x'.repeat(23000));
  const candidates = await describeCanonicalCandidates(snapshot, searchCanonicalBlocks(snapshot.blocks, 'needle'), db);
  expect(candidates).toHaveLength(1); expect(candidates[0].premiseBlockIds).toHaveLength(1); expect(candidates[0].block.text).toContain('needle');
});
it('refuses forged worker IDs/scores, duplicate hits, invalid query limits and interrupted operations', async () => {
  const { snapshot, b } = await fixture();
  for (const hits of [[{ blockId: 'missing', score: 1 }], [{ blockId: b.blockId, score: NaN }], [{ blockId: b.blockId, score: 1 }, { blockId: b.blockId, score: 2 }]]) await expect(describeCanonicalCandidates(snapshot, hits, db)).rejects.toThrow('ID');
  for (const query of ['', 'x'.repeat(2001)]) expect(() => searchCanonicalBlocks(snapshot.blocks, query)).toThrow('2,000');
  expect(() => searchCanonicalBlocks(snapshot.blocks, 'needle', 13)).toThrow('한도');
  const aborted = new AbortController(); aborted.abort(); await expect(describeCanonicalCandidates(snapshot, [], db, aborted.signal)).rejects.toThrow();
});
it('rejects prior-version snapshots and graph changes occurring between candidate checks', async () => {
  const { snapshot, relation } = await fixture(); const hits = searchCanonicalBlocks(snapshot.blocks, 'needle');
  const actual = graphService.prepareGraphContext;
  vi.spyOn(graphService, 'prepareGraphContext').mockImplementation(async (...args) => {
    const graph = await actual(...args); await retractRelation(relation.id, 'Changed while searching', db); return graph;
  });
  await expect(describeCanonicalCandidates(snapshot, hits, db)).rejects.toThrow('검색 중 변경'); vi.restoreAllMocks();
  await saveTheoryVersion(snapshot.document.id, snapshot.version.id, { title: 'Changed', markdown: snapshot.version.markdown, contract: snapshot.version.contract }, db);
  await expect(describeCanonicalCandidates(snapshot, hits, db)).rejects.toThrow('정본이 변경');
});
