import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { hashText, splitMarkdown } from './blocks';
import { loadTheory } from './documents';
import { anchorKey, type ClaimAnchor, type ResearchRelation } from './relationTypes';
import { parseRelationData, verifyRelationHashes } from './relationValidation';
import { relationGraph } from './relationGraph';
import { prepareReviewRequest } from './reviews';
import type { TheorySnapshot } from './types';
import type { ReviewGraphContext } from './reviewGraphTypes';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export const graphContextHash = (context: Omit<ReviewGraphContext, 'contextHash'>) => hashText(JSON.stringify(canonical({
  version: context.version, versionId: context.versionId, versionHash: context.versionHash, graphFingerprint: context.graphFingerprint,
  targetBlockIds: context.targetBlockIds, premiseBlockIds: context.premiseBlockIds, relationSnapshots: context.relationSnapshots,
  excludedCounts: context.excludedCounts, proofCycleRelationIds: context.proofCycleRelationIds
})));
export function graphClosure(targetBlockIds: string[], relations: ResearchRelation[]) {
  const reached = new Set<string>();
  for (const r of relations) for (const anchor of [r.from, r.to]) if (anchor.type === 'claim' && targetBlockIds.includes(anchor.blockId)) reached.add(anchorKey(anchor));
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of relations) if (r.to.type === 'claim' && ['depends_on', 'defines'].includes(r.kind) && reached.has(anchorKey(r.from)) && !reached.has(anchorKey(r.to))) {
      reached.add(anchorKey(r.to)); changed = true;
    }
  }
  const included = relations.filter(r => r.to.type === 'claim' && reached.has(anchorKey(r.from)) && reached.has(anchorKey(r.to)));
  const blockIds = new Set(targetBlockIds);
  for (const r of included) for (const a of [r.from, r.to]) if (a.type === 'claim') blockIds.add(a.blockId);
  return { included, reached, blockIds };
}

// This local signature contains unselected data. Never serialize it into a model request.
export async function readGraphReviewState(documentId: string, db: QaxiomDatabase) {
  return db.transaction('r', [db.theory_documents, db.document_versions, db.document_blocks, db.review_runs, db.research_relations], async () => {
    const snapshot = await loadTheory(documentId, db);
    const runs = await db.review_runs.where('documentId').equals(documentId).toArray();
    const relations = (await db.research_relations.where('documentId').equals(documentId).toArray()).sort((a, b) => a.id.localeCompare(b.id));
    const anchors = new Map<string, ClaimAnchor>();
    for (const r of relations) for (const a of [r.from, r.to]) if (a.type === 'claim') anchors.set(anchorKey(a), a);
    const anchorStates = [...anchors].sort(([a], [b]) => a.localeCompare(b)).map(([key, a]) => {
      const run = runs.find(r => r.id === a.runId);
      return { key, versionId: run?.versionId ?? null, versionHash: run?.versionHash ?? null, status: run?.status ?? null,
        claim: run?.claims.find(c => c.id === a.claimId) ?? null };
    });
    const externalReviewStates = [...new Set(relations.flatMap(r => r.externalReviewOrigin ? [r.externalReviewOrigin.runId] : []))].sort().map(id => ({ id, run: runs.find(r => r.id === id) ?? null }));
    const signature = JSON.stringify({ version: snapshot.version, blocks: snapshot.blocks, relations, anchorStates, ...(externalReviewStates.length ? { externalReviewStates } : {}) });
    const entries = relations.map(r => {
      const nodes = [r.from, r.to].filter((a): a is ClaimAnchor => a.type === 'claim');
      const status = r.retractedAt !== null ? 'retracted' as const : nodes.some(a => a.versionId !== snapshot.version.id) ? 'stale' as const
        : nodes.some(a => runs.find(run => run.id === a.runId)?.claims.find(c => c.id === a.claimId)?.acceptance !== 'accepted') ? 'claim_unaccepted' as const : 'active' as const;
      return { relation: r, status };
    });
    return { snapshot, runs, relations, entries, signature };
  });
}
export async function prepareReviewGraphContext(snapshot: TheorySnapshot, selected: string[], db: QaxiomDatabase = qaxiomDatabase) {
  const state = await readGraphReviewState(snapshot.document.id, db);
  if (JSON.stringify(state.snapshot.version) !== JSON.stringify(snapshot.version) || JSON.stringify(state.snapshot.blocks) !== JSON.stringify(snapshot.blocks)) throw new Error('정본 버전/원문이 바뀌었습니다. 다시 확인하세요.');
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !snapshot.blocks.some(b => b.id === id))) throw new Error('검토할 현재 블록을 선택하세요.');
  const parts = splitMarkdown(snapshot.version.markdown);
  if (parts.length !== snapshot.blocks.length || snapshot.blocks.some((block, index) => block.versionId !== snapshot.version.id
    || block.documentId !== snapshot.document.id || block.position !== index || block.startOffset !== parts[index].startOffset
    || block.endOffset !== parts[index].endOffset || block.kind !== parts[index].kind || block.text !== parts[index].text)) throw new Error('정본 블록의 원문 위치/구조가 일치하지 않습니다.');
  await verifyRelationHashes({ researchRelations: state.relations }, state.runs);
  const active = state.entries.filter(e => e.status === 'active').map(e => e.relation);
  const targetBlockIds = snapshot.blocks.filter(b => selected.includes(b.id)).map(b => b.id);
  const closure = graphClosure(targetBlockIds, active);
  const relationSnapshots = parseRelationData({ researchRelations: closure.included }, { projects: [], theoryDocuments: [snapshot.document], documentVersions: snapshot.history, documentBlocks: snapshot.blocks }, { reviewRuns: state.runs }, { references: [], referenceSpans: [] }).researchRelations;
  const blockIds = snapshot.blocks.filter(b => closure.blockIds.has(b.id)).map(b => b.id);
  if (await hashText(snapshot.version.markdown) !== snapshot.version.contentHash) throw new Error('정본 해시가 일치하지 않습니다.');
  for (const b of snapshot.blocks.filter(b => blockIds.includes(b.id))) if (await hashText(b.text) !== b.contentHash) throw new Error('검토 원문 블록 해시가 일치하지 않습니다.');
  const excludedCounts = { stale: 0, retracted: 0, claim_unaccepted: 0, outside_scope: 0, external_not_selected: 0 };
  for (const entry of state.entries) {
    if (entry.status !== 'active') excludedCounts[entry.status]++;
    else if (entry.relation.to.type === 'reference') excludedCounts.external_not_selected++;
    else if (!relationSnapshots.some(r => r.id === entry.relation.id)) excludedCounts.outside_scope++;
  }
  const payload = { version: 1 as const, versionId: snapshot.version.id, versionHash: snapshot.version.contentHash,
    graphFingerprint: await hashText(state.signature), targetBlockIds, premiseBlockIds: blockIds.filter(id => !targetBlockIds.includes(id)), relationSnapshots,
    excludedCounts, proofCycleRelationIds: relationGraph(relationSnapshots, '').proofCycleRelationIds };
  const graph: ReviewGraphContext = { ...payload, contextHash: await graphContextHash(payload) };
  return { graph, blockIds, stateSignature: state.signature };
}
export async function prepareGraphReview(snapshot: TheorySnapshot, selected: string[], db: QaxiomDatabase = qaxiomDatabase) {
  const prepared = await prepareReviewGraphContext(snapshot, selected, db);
  return { ...prepared, request: prepareReviewRequest(snapshot, prepared.blockIds, prepared.graph) };
}
export type GraphReviewPreparation = Awaited<ReturnType<typeof prepareGraphReview>>;
export async function assertGraphReviewCurrent(snapshot: TheorySnapshot, prepared: GraphReviewPreparation, db: QaxiomDatabase = qaxiomDatabase) {
  const fresh = await prepareGraphReview(snapshot, prepared.graph.targetBlockIds, db);
  if (await graphContextHash(prepared.graph) !== prepared.graph.contextHash || fresh.graph.contextHash !== prepared.graph.contextHash
    || JSON.stringify(fresh.blockIds) !== JSON.stringify(prepared.blockIds) || fresh.request !== prepared.request || fresh.stateSignature !== prepared.stateSignature) throw new Error('승인 그래프/채택/원문이 변경되었습니다. 미리보기를 다시 확인하세요. 이미 전송했다면 제공사 비용은 미확인입니다.');
}
