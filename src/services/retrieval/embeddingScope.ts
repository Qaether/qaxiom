import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { hashText } from '../theory/blocks';
import { assertProjectSources, parseProjectSourcePolicy } from '../theory/projectSources';
import type { ProjectSourcePolicy } from '../theory/types';

const CHANGED = '정본/프로젝트 자료 정책이 변경되었습니다. 임베딩 전송 미리보기를 다시 확인하세요. 전송 후 변경이라면 제공사 비용은 미확인입니다.';

/** Only a locally frozen approval. This object is never part of an embedding request body. */
export interface EmbeddingProjectScope {
  projectId: string;
  versionId: string | null;
  versionHash: string | null;
  policyScope: ProjectSourcePolicy['scope'] | null;
  policyRevision: number | null;
  policyHash: string | null;
  policySignature: string | null;
  sourceIds: string[];
}

async function readScope(versionId: string, sourceIds: string[], db: QaxiomDatabase, projectId = '') {
  const state = await db.transaction('r', [db.projects, db.theory_documents, db.document_versions], async () => {
    const version = versionId ? await db.document_versions.get(versionId) : null;
    const document = version && await db.theory_documents.get(version.documentId);
    const project = await db.projects.get(versionId ? document?.projectId ?? '' : projectId);
    if (!project || (versionId && (!version || !document || document.currentVersionId !== versionId || (projectId && project.id !== projectId)))) throw new Error(CHANGED);
    const policy = project.sourcePolicy ? parseProjectSourcePolicy(project.sourcePolicy) : null;
    if (policy?.scope === 'research') assertProjectSources(project, sourceIds);
    return { version, document, project, policy };
  });
  if (state.version && await hashText(state.version.markdown) !== state.version.contentHash) throw new Error('정본 원문 해시가 일치하지 않습니다.');
  const policySignature = state.policy ? JSON.stringify(state.policy) : null;
  return { projectId: state.project.id, versionId: state.version?.id ?? null, versionHash: state.version?.contentHash ?? null,
    policyScope: state.policy?.scope ?? null, policyRevision: state.policy?.revision ?? null,
    policyHash: policySignature ? await hashText(policySignature) : null, policySignature,
    sourceIds: [...sourceIds] } satisfies EmbeddingProjectScope;
}

export async function captureEmbeddingScope(versionId: string, sourceIds: string[], db: QaxiomDatabase = qaxiomDatabase, projectId = ''): Promise<EmbeddingProjectScope | null> {
  if (!versionId && !projectId) return null;
  const scope = await readScope(versionId, sourceIds, db, projectId);
  await assertEmbeddingScopeCurrent(scope, sourceIds, db);
  return scope;
}

export async function assertEmbeddingScopeCurrent(scope: EmbeddingProjectScope | null, sourceIds: string[], db: QaxiomDatabase = qaxiomDatabase) {
  if (!scope) return;
  if (JSON.stringify(sourceIds) !== JSON.stringify(scope.sourceIds)) throw new Error('임베딩 선택 자료가 변경되었습니다. 미리보기를 다시 확인하세요.');
  const actual = await readScope(scope.versionId ?? '', sourceIds, db, scope.projectId);
  if (JSON.stringify(actual) !== JSON.stringify(scope)) throw new Error(CHANGED);
}

/** Call inside a transaction that includes projects, theory_documents and document_versions. */
export async function assertEmbeddingScopeInTransaction(scope: EmbeddingProjectScope | null, db: QaxiomDatabase) {
  if (!scope) return;
  const version = scope.versionId ? await db.document_versions.get(scope.versionId) : null;
  const document = version && await db.theory_documents.get(version.documentId);
  const project = await db.projects.get(scope.versionId ? document?.projectId ?? '' : scope.projectId);
  if (!project || (scope.versionId && (!version || !document || document.currentVersionId !== scope.versionId || version.contentHash !== scope.versionHash))
    || project.id !== scope.projectId || (project.sourcePolicy ? JSON.stringify(parseProjectSourcePolicy(project.sourcePolicy)) : null) !== scope.policySignature) throw new Error(CHANGED);
  if (project.sourcePolicy?.scope === 'research') assertProjectSources(project, scope.sourceIds);
}
