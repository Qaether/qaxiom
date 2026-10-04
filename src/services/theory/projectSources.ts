import type { ProjectSourcePolicy, ResearchProject } from './types';

// Previously saved policies stay enforceable, but there is no longer a policy editor.
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
    if (sourceIds.some(id => !policy.allowedSourceIds.includes(id))) throw new Error('기존 프로젝트의 허용 목록에 없는 자료입니다. 현재 버전에서는 이 정책을 변경할 수 없습니다. 허용된 자료만 선택하세요.');
  }
}
