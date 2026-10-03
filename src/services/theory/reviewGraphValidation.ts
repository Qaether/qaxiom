import type { ReviewGraphContext } from './reviewGraphTypes';
import type { TheoryData } from './types';
import type { ReviewData } from './reviewTypes';
import type { RelationData, ResearchRelation } from './relationTypes';
import { parseRelationData, relationHash } from './relationValidation';
import { graphClosure, graphContextHash } from './reviewGraph';
import { relationGraph } from './relationGraph';

export function parseReviewGraph(input: unknown, versionId: string, theory: TheoryData, reviews: ReviewData): ReviewGraphContext {
  function fail(): never { throw new Error('검토 그래프의 버전·범위·승인 원문 참조가 올바르지 않습니다.'); }
  const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const ids = (x: unknown): x is string[] => Array.isArray(x) && x.every(v => typeof v === 'string' && !!v.trim()) && new Set(x).size === x.length;
  const digest = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
  const version = theory.documentVersions.find(v => v.id === versionId);
  if (!version || !record(input) || input.version !== 1 || input.versionId !== versionId || input.versionHash !== version.contentHash
    || !digest(input.contextHash) || !digest(input.graphFingerprint) || !ids(input.targetBlockIds) || !input.targetBlockIds.length
    || !ids(input.premiseBlockIds) || !ids(input.proofCycleRelationIds) || !record(input.excludedCounts)) fail();
  const blocks = theory.documentBlocks.filter(b => b.versionId === versionId).sort((a, b) => a.position - b.position);
  const target = input.targetBlockIds as string[], premise = input.premiseBlockIds as string[];
  if (new Set([...target, ...premise]).size !== target.length + premise.length || [...target, ...premise].some(id => !blocks.some(b => b.id === id))) fail();
  const relationSnapshots = parseRelationData({ researchRelations: input.relationSnapshots }, theory, reviews, { references: [], referenceSpans: [] }).researchRelations;
  if (relationSnapshots.some(r => r.documentId !== version.documentId || r.retractedAt !== null || r.from.versionId !== versionId || r.to.type !== 'claim' || r.to.versionId !== versionId)) fail();
  const closure = graphClosure(target, relationSnapshots);
  const expected = blocks.filter(b => closure.blockIds.has(b.id) && !target.includes(b.id)).map(b => b.id);
  if (JSON.stringify(expected) !== JSON.stringify(premise) || closure.included.length !== relationSnapshots.length
    || JSON.stringify(relationGraph(relationSnapshots, '').proofCycleRelationIds) !== JSON.stringify(input.proofCycleRelationIds)) fail();
  const excludedCounts = { stale: 0, retracted: 0, claim_unaccepted: 0, outside_scope: 0, external_not_selected: 0 };
  for (const key of Object.keys(excludedCounts) as (keyof typeof excludedCounts)[]) {
    const value = input.excludedCounts[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1000) fail(); excludedCounts[key] = value;
  }
  if (Object.values(excludedCounts).reduce((a, b) => a + b, 0) + relationSnapshots.length > 1000) fail();
  return { version: 1, versionId, versionHash: version.contentHash, graphFingerprint: input.graphFingerprint, contextHash: input.contextHash,
    targetBlockIds: target, premiseBlockIds: premise, relationSnapshots, excludedCounts, proofCycleRelationIds: input.proofCycleRelationIds };
}
const immutableRelation = (r: ResearchRelation) => ({ id: r.id, documentId: r.documentId, from: r.from, to: r.to, kind: r.kind,
  dependencyType: r.dependencyType, assessment: r.assessment, note: r.note, createdAt: r.createdAt });
export function validateGraphRelations(graph: ReviewGraphContext, data: RelationData) {
  for (const frozen of graph.relationSnapshots) {
    const current = data.researchRelations.find(r => r.id === frozen.id);
    if (!current || JSON.stringify(immutableRelation(current)) !== JSON.stringify(immutableRelation(frozen))) throw new Error('검토 그래프의 승인 관계 계보가 일치하지 않습니다.');
  }
}
export async function verifyReviewGraphHashes(graphs: ReviewGraphContext[]) {
  for (const graph of graphs) {
    if (await graphContextHash(graph) !== graph.contextHash) throw new Error('검토 그래프 문맥 해시가 일치하지 않습니다. 기존 작업공간을 유지합니다.');
    for (const r of graph.relationSnapshots) if (await relationHash(r) !== r.relationHash) throw new Error('검토 그래프의 고정 관계 해시가 일치하지 않습니다.');
  }
}
