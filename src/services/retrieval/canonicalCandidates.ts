import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { loadTheory } from '../theory/documents';
import type { TheorySnapshot } from '../theory/types';
import { sameContextValue } from './assembly';
import { prepareGraphContext } from './graphContext';
import type { CanonicalHit } from './canonicalRanking';
import { readGraphReviewState } from '../theory/reviewGraph';

export async function describeCanonicalCandidates(snapshot: TheorySnapshot, hits: CanonicalHit[], db: QaxiomDatabase = qaxiomDatabase, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (hits.length > 12 || new Set(hits.map(h => h.blockId)).size !== hits.length
    || hits.some(h => !snapshot.blocks.some(b => b.id === h.blockId) || !Number.isFinite(h.score) || h.score <= 0)) throw new Error('정본 후보의 원문 ID/점수가 올바르지 않습니다.');
  const state = await readGraphReviewState(snapshot.document.id, db);
  if (!sameContextValue(snapshot.version, state.snapshot.version) || !sameContextValue(snapshot.blocks, state.snapshot.blocks)) throw new Error('정본이 변경되었습니다. 기준을 다시 선택하세요.');
  const result: { block: TheorySnapshot['blocks'][number]; score: number; premiseBlockIds: string[]; relationCount: number; proofCycleCount: number; excludedExternalCount: number }[] = [];
  for (const hit of hits) {
    signal?.throwIfAborted();
    const block = snapshot.blocks.find(b => b.id === hit.blockId)!;
    const graph = await prepareGraphContext(snapshot, [block.id], db);
    result.push({ block: structuredClone(block), score: hit.score, premiseBlockIds: graph.context.premiseBlockIds,
      relationCount: graph.context.relationSnapshots.length, proofCycleCount: graph.context.proofCycleRelationIds.length,
      excludedExternalCount: graph.context.excludedCounts.external_not_selected });
  }
  signal?.throwIfAborted();
  const latest = await loadTheory(snapshot.document.id, db);
  if (!sameContextValue(snapshot.version, latest.version) || (await readGraphReviewState(snapshot.document.id, db)).signature !== state.signature) throw new Error('정본/승인 관계/채택이 검색 중 변경되었습니다. 다시 검색하세요.');
  return result;
}
export type CanonicalCandidate = Awaited<ReturnType<typeof describeCanonicalCandidates>>[number];
