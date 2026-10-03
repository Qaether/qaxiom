import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import type { ProjectSourcePolicy, ResearchProject, TheorySnapshot } from './types';

export function parseProjectSourcePolicy(value: unknown): ProjectSourcePolicy {
  const p = value as ProjectSourcePolicy;
  if (!p || !['external_review', 'research'].includes(p.scope) || !Number.isSafeInteger(p.revision) || p.revision < 1 || !Array.isArray(p.allowedSourceIds)
    || p.allowedSourceIds.length > 1000 || p.allowedSourceIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(p.allowedSourceIds).size !== p.allowedSourceIds.length) throw new Error('프로젝트 외부 대조 자료 정책이 올바르지 않습니다.');
  return { scope: p.scope, revision: p.revision, allowedSourceIds: [...p.allowedSourceIds] };
}
export function assertProjectSources(project: ResearchProject | undefined, sourceIds: string[]) {
  if (!project) throw new Error('현재 프로젝트가 없습니다. 문서를 다시 여세요.');
  if (project.sourcePolicy) {
    const policy = parseProjectSourcePolicy(project.sourcePolicy);
    if (sourceIds.some(id => !policy.allowedSourceIds.includes(id))) throw new Error('프로젝트 외부 대조 허용 목록에 없는 자료입니다. 목록을 수정하거나 허용 자료만 선택하세요.');
  }
}
export async function saveProjectSources(snapshot: TheorySnapshot, expectedRevision: number | null, sourceIds: string[], db: QaxiomDatabase = qaxiomDatabase, scope: ProjectSourcePolicy['scope'] = 'external_review') {
  const policy = parseProjectSourcePolicy({ scope, revision: (expectedRevision ?? 0) + 1, allowedSourceIds: [...sourceIds].sort() });
  await db.transaction('rw', [db.projects, db.theory_documents, db.references], async () => {
    const document = await db.theory_documents.get(snapshot.document.id), project = await db.projects.get(snapshot.document.projectId);
    if (!document || document.projectId !== snapshot.document.projectId || document.currentVersionId !== snapshot.version.id || !project
      || (project.sourcePolicy?.revision ?? null) !== expectedRevision) throw new Error('프로젝트/자료 정책/문서가 변경되었습니다. 다시 읽어 확인하세요.');
    if ((await db.references.bulkGet(policy.allowedSourceIds)).some(s => !s)) throw new Error('허용할 원문 자료가 없습니다.');
    await db.projects.update(project.id, { sourcePolicy: policy });
  });
  return policy;
}
