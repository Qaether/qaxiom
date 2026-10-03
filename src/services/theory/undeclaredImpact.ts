import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { hashText, verifyCanonicalSnapshot } from './blocks';
import { currentPatchImpactScope, patchContentHash } from './patchImpact';
import { readGraphReviewState } from './reviewGraph';
import { prepareReviewGraphContext } from './reviewGraph';
import { rankUndeclaredImpact, type ImpactRanking, type ImpactRankingInput } from './impactRanking';
import type { TheorySnapshot } from './types';

export async function prepareUndeclaredImpact(runId: string, patchId: string, snapshot: TheorySnapshot, db: QaxiomDatabase = qaxiomDatabase,
  rank: (input: ImpactRankingInput) => Promise<ImpactRanking> = async input => rankUndeclaredImpact(input)) {
  const state = await readGraphReviewState(snapshot.document.id, db);
  await verifyCanonicalSnapshot(snapshot);
  const scope = await currentPatchImpactScope(runId, patchId, snapshot, db);
  const run = await db.review_runs.get(runId), patch = run?.patches.find(p => p.id === patchId);
  if (!run || !patch?.impact || await patchContentHash(run, patch) !== patch.impact.patchHash) throw new Error('수정 제안/영향 이력이 변경되었습니다.');
  const version = await db.document_versions.get(run.versionId);
  const blocks = await db.document_blocks.where('versionId').equals(run.versionId).sortBy('position');
  if (!version || version.documentId !== snapshot.document.id || version.contentHash !== run.versionHash) throw new Error('수정 전 원문/버전 hash가 다릅니다. 전체 문서를 재검사하세요.');
  await verifyCanonicalSnapshot({ ...snapshot, version, blocks });
  const before = blocks.find(b => b.id === patch.blockId);
  if (!before || before.contentHash !== patch.beforeHash) throw new Error('수정 전 원문 hash가 다릅니다.');
  const input = { before: before.text, replacement: patch.replacement, blocks: snapshot.blocks, excludedBlockIds: scope.blockIds };
  const ranking = await rank(input);
  if ((await readGraphReviewState(snapshot.document.id, db)).signature !== state.signature
    || JSON.stringify(await db.review_runs.get(runId)) !== JSON.stringify(run)) throw new Error('후보 검색 중 원문/승인/수정 이력이 변경되었습니다. 다시 검색하세요.');
  return { versionId: snapshot.version.id, stateHash: await hashText(state.signature), patchHash: patch.impact.patchHash, scopeBlockIds: scope.blockIds, fullScope: scope.fullScope, ranking };
}
export type UndeclaredImpact = Awaited<ReturnType<typeof prepareUndeclaredImpact>>;

export async function selectUndeclaredImpact(runId: string, patchId: string, snapshot: TheorySnapshot, approved: UndeclaredImpact, selected: string[], db: QaxiomDatabase = qaxiomDatabase) {
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !approved.ranking.matches.some(m => m.blockId === id))) throw new Error('표시된 후보를 명시적으로 선택하세요.');
  const fresh = await prepareUndeclaredImpact(runId, patchId, snapshot, db);
  if (JSON.stringify(fresh) !== JSON.stringify(approved)) throw new Error('수정 후보/원문이 변경되었습니다. 다시 검색하세요.');
  const ids = new Set([...fresh.scopeBlockIds, ...selected]);
  const graph = await prepareReviewGraphContext(snapshot, snapshot.blocks.filter(b => ids.has(b.id)).map(b => b.id), db);
  if (await hashText(graph.stateSignature) !== fresh.stateHash) throw new Error('후보 선택 중 승인 전제가 변경되었습니다. 다시 검색하세요.');
  for (const id of graph.graph.premiseBlockIds) ids.add(id);
  return snapshot.blocks.filter(b => ids.has(b.id)).map(b => b.id);
}

export function rankImpactInWorker(input: ImpactRankingInput, signal: AbortSignal): Promise<ImpactRanking> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./impact.worker.ts', import.meta.url), { type: 'module' });
    const finish = (error?: Error, result?: ImpactRanking) => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel); worker.terminate();
      if (error) reject(error); else if (result) resolve(result); else reject(new Error('수정 후보 결과가 없습니다.'));
    };
    const cancel = () => finish(new Error('수정 후보 검색을 취소했습니다.'));
    const timer = setTimeout(() => finish(new Error('수정 후보 검색이 30초를 초과했습니다.')), 30000);
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = event => event.data.error ? finish(new Error(event.data.error)) : finish(undefined, event.data.result);
    worker.onerror = () => finish(new Error('수정 후보 Worker 오류'));
    try { worker.postMessage(input); }
    catch (cause) { finish(cause instanceof Error ? cause : new Error('수정 후보 Worker 전송 실패')); }
  });
}
