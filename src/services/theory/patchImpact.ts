import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { hashText } from './blocks';
import { prepareReviewGraphContext, readGraphReviewState } from './reviewGraph';
import type { ReviewGraphContext } from './reviewGraphTypes';
import type { ResearchRelation } from './relationTypes';
import type { TheorySnapshot, DocumentBlock } from './types';
import { verifyReviewGraphHashes } from './reviewGraphValidation';
import type { ReviewRun, TheoryPatch } from './reviewTypes';

export interface PatchImpact {
  version: 1;
  graph: ReviewGraphContext;
  contractChanged: boolean;
  patchHash: string;
}

export const patchContentHash = (run: ReviewRun, patch: TheoryPatch) => hashText(JSON.stringify({
  runId: run.id, documentId: run.documentId, versionId: run.versionId, versionHash: run.versionHash,
  patchId: patch.id, issueIds: patch.issueIds, blockId: patch.blockId, beforeHash: patch.beforeHash,
  replacement: patch.replacement, introducedAssumptions: patch.introducedAssumptions
}));
export async function verifyPatchImpactHashes(runs: ReviewRun[]) {
  for (const run of runs) for (const patch of run.patches) if (patch.impact && await patchContentHash(run, patch) !== patch.impact.patchHash) throw new Error('수정 제안과 영향 승인 hash가 다릅니다. 기존 작업공간을 유지합니다.');
}

/** Conservative block-level reverse dependencies; compatibility edges require both ends to be rechecked. */
export function impactedBlocks(blockId: string, relations: ResearchRelation[]) {
  const reached = new Set([blockId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of relations) {
      if (r.to.type !== 'claim') continue;
      const from = r.from.blockId, to = r.to.blockId;
      if (reached.has(to) && !reached.has(from)) { reached.add(from); changed = true; }
      if (['supports', 'contradicts'].includes(r.kind) && reached.has(from) && !reached.has(to)) { reached.add(to); changed = true; }
    }
  }
  return reached;
}

export async function preparePatchImpact(runId: string, patchId: string, db: QaxiomDatabase = qaxiomDatabase) {
  const run = await db.review_runs.get(runId), patch = run?.patches.find(p => p.id === patchId);
  if (!run || !patch || run.status !== 'complete' || patch.appliedVersionId) throw new Error('적용할 수정 제안이 없거나 이미 적용되었습니다.');
  const state = await readGraphReviewState(run.documentId, db);
  const block = state.snapshot.blocks.find(b => b.id === patch.blockId);
  if (state.snapshot.version.id !== run.versionId || state.snapshot.version.contentHash !== run.versionHash || !block || block.contentHash !== patch.beforeHash) throw new Error('오래된 수정 제안입니다. 최신 버전을 다시 검토하세요.');
  const contractChanged = !!patch.introducedAssumptions.trim();
  const affected = impactedBlocks(patch.blockId, state.entries.filter(e => e.status === 'active').map(e => e.relation));
  const selected = state.snapshot.blocks.filter(b => contractChanged || affected.has(b.id)).map(b => b.id);
  // Impact inspection is local and may exceed a model request budget. Nothing is truncated or sent.
  const prepared = await prepareReviewGraphContext(state.snapshot, selected, db);
  if (prepared.stateSignature !== state.signature || (await readGraphReviewState(run.documentId, db)).signature !== state.signature) throw new Error('수정 영향 확인 중 승인 그래프/원문이 변경되었습니다.');
  return { impact: { version: 1 as const, graph: prepared.graph, contractChanged, patchHash: await patchContentHash(run, patch) }, stateSignature: state.signature };
}

export async function assertPatchImpactCurrent(runId: string, patchId: string, impact: PatchImpact, db: QaxiomDatabase = qaxiomDatabase) {
  const fresh = await preparePatchImpact(runId, patchId, db);
  if (impact.version !== 1 || impact.contractChanged !== fresh.impact.contractChanged || impact.graph.contextHash !== fresh.impact.graph.contextHash
    || JSON.stringify(impact) !== JSON.stringify(fresh.impact)) throw new Error('수정 영향 범위가 변경되었습니다. 다시 확인한 뒤 승인하세요.');
  return fresh;
}

/** Old approvals only nominate scope. They never become active claims/relations in a new version. */
export async function currentPatchImpactScope(runId: string, patchId: string, snapshot: TheorySnapshot, db: QaxiomDatabase = qaxiomDatabase) {
  const run = await db.review_runs.get(runId), patch = run?.patches.find(p => p.id === patchId);
  if (!run || !patch?.impact || !patch.appliedVersionId || run.documentId !== snapshot.document.id) throw new Error('저장된 수정 영향 이력이 없습니다.');
  await verifyReviewGraphHashes([patch.impact.graph]);
  await verifyPatchImpactHashes([run]);
  const state = await readGraphReviewState(run.documentId, db);
  if (JSON.stringify(state.snapshot.version) !== JSON.stringify(snapshot.version) || JSON.stringify(state.snapshot.blocks) !== JSON.stringify(snapshot.blocks)) throw new Error('정본 버전/원문이 변경되었습니다.');
  const history = new Map(snapshot.history.map(v => [v.id, v]));
  const chain = []; let version = snapshot.version;
  while (version.id !== run.versionId) {
    chain.push(version);
    const parent = version.parentVersionId && history.get(version.parentVersionId);
    if (!parent || chain.length > snapshot.history.length) throw new Error('현재 문서는 수정 적용의 후속 버전이 아닙니다.');
    version = parent;
  }
  if (!chain.some(v => v.id === patch.appliedVersionId)) throw new Error('현재 문서는 수정 적용의 후속 버전이 아닙니다.');
  let ids = new Set([...patch.impact.graph.targetBlockIds, ...patch.impact.graph.premiseBlockIds]);
  let previous = await db.document_blocks.where('versionId').equals(run.versionId).sortBy('position');
  let full = patch.impact.contractChanged, lost = false;
  for (const next of chain.reverse()) {
    const blocks = await db.document_blocks.where('versionId').equals(next.id).sortBy('position');
    const mapped = new Set<string>();
    for (const id of ids) {
      const descendants = blocks.filter(b => b.id === id || b.predecessorIds.includes(id));
      if (!descendants.length) lost = true;
      for (const b of descendants) mapped.add(b.id);
    }
    // Later edits/additions and contract changes are also recheck candidates.
    for (const b of blocks) if (!previous.some(old => old.id === b.id && old.contentHash === b.contentHash)) mapped.add(b.id);
    const parent = history.get(next.parentVersionId!);
    if (!parent || JSON.stringify(parent.contract) !== JSON.stringify(next.contract)) full = true;
    ids = mapped; previous = blocks;
  }
  if (await hashText(snapshot.version.markdown) !== snapshot.version.contentHash) throw new Error('정본 hash가 일치하지 않습니다.');
  for (const b of snapshot.blocks) if (await hashText(b.text) !== b.contentHash) throw new Error('정본 블록 hash가 일치하지 않습니다.');
  const blocks: DocumentBlock[] = snapshot.blocks.filter(b => full || lost || ids.has(b.id));
  if ((await readGraphReviewState(run.documentId, db)).signature !== state.signature) throw new Error('수정 영향 선택 중 원문이 변경되었습니다.');
  return { versionId: snapshot.version.id, blockIds: blocks.map(b => b.id), fullScope: full || lost, lostLineage: lost, impact: patch.impact };
}
