import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { hashText } from '../theory/blocks';
import { validateContractAnchors } from '../theory/documents';
import { assertProjectSources, parseProjectSourcePolicy } from '../theory/projectSources';
import { assembleContext, sameContextValue } from './assembly';
import { loadReferenceSelection } from './references';
import type { ContextBundle } from './types';

const CHANGED = '프로젝트 자료 정책/소속 또는 정본이 변경되었습니다. 검색 미리보기를 다시 확인하세요. 전송 후 변경이라면 제공사 비용은 미확인입니다.';
export function parseRagProjectScope(value: unknown): NonNullable<ContextBundle['projectScope']> {
  const p = value as NonNullable<ContextBundle['projectScope']>;
  if (!p || typeof p.projectId !== 'string' || !p.projectId.trim()
    || ![null, 'external_review', 'research'].includes(p.policyScope)
    || (p.policyRevision !== null && (!Number.isSafeInteger(p.policyRevision) || p.policyRevision < 1))
    || (p.policyHash !== null && (typeof p.policyHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.policyHash)))
    || (p.mode !== undefined && p.mode !== 'project_only')
    || (p.policyRevision === null) !== (p.policyHash === null) || (p.policyScope === null) !== (p.policyHash === null)) throw new Error('RAG 프로젝트 범위가 올바르지 않습니다.');
  return { projectId: p.projectId, policyScope: p.policyScope, policyRevision: p.policyRevision, policyHash: p.policyHash,
    ...(p.mode ? { mode: p.mode } : {}) };
}

async function readState(bundle: ContextBundle, db: QaxiomDatabase) {
  const research = bundle.assembly?.research;
  const projectOnly = bundle.projectScope?.mode === 'project_only';
  if (!research && !projectOnly) {
    if (bundle.projectScope) throw new Error('프로젝트 범위에 정본 연구 기준이 없습니다.');
    return null;
  }
  return db.transaction('r', [db.projects, db.theory_documents, db.document_versions, db.document_blocks, db.references, db.reference_spans], async () => {
    if (projectOnly && (research || bundle.graph || !bundle.assembly)) throw new Error('프로젝트 단독 범위와 정본 기준/그래프를 혼합할 수 없습니다.');
    const document = research ? await db.theory_documents.get(research.documentId) : null;
    const version = research ? await db.document_versions.get(research.versionId) : null;
    if (version?.contractAnchors && Object.keys(version.contractAnchors).length)
      validateContractAnchors(version.contractAnchors, version.contract, await db.document_blocks.where('versionId').equals(version.id).toArray());
    const project = await db.projects.get(projectOnly ? bundle.projectScope!.projectId : document?.projectId ?? '');
    if (!project || (research && (!document || !version || document.currentVersionId !== version.id || version.documentId !== document.id))) throw new Error(CHANGED);
    const policy = project.sourcePolicy ? parseProjectSourcePolicy(project.sourcePolicy) : null;
    if (policy?.scope === 'research') assertProjectSources(project, bundle.selectedSourceIds);
    const data = bundle.selectedSourceIds.length ? await loadReferenceSelection(bundle.selectedSourceIds, db) : { references: [], referenceSpans: [] };
    return { document, version, project, policy, data };
  });
}

/** Frozen scope is approved in the preview. Do not silently refresh it at send time. */
export async function assertRagProjectScopeCurrent(bundle: ContextBundle, db: QaxiomDatabase = qaxiomDatabase): Promise<string | null> {
  const state = await readState(bundle, db);
  if (!state) return null;
  if (state.version && await hashText(state.version.markdown) !== state.version.contentHash) throw new Error('정본 원문 해시가 일치하지 않습니다.');
  const matched = bundle.assembly!.matchedSpanIds.map(id => {
    const item = bundle.evidence.find(e => e.span.id === id);
    const span = state.data.referenceSpans.find(s => s.id === id);
    const source = span && state.data.references.find(s => s.id === span.sourceId);
    if (!item || !span || !source || !sameContextValue(item.span, span)) throw new Error('선택 원문이 변경되었습니다. 다시 검색하세요.');
    return { source, span, score: item.score };
  });
  for (const source of state.data.references) if (await hashText(source.text) !== source.contentHash) throw new Error('원문 해시가 일치하지 않습니다.');
  for (const span of state.data.referenceSpans) if (await hashText(span.text) !== span.contentHash) throw new Error('원문 구간 해시가 일치하지 않습니다.');
  const expected = assembleContext(bundle.query, bundle.selectedSourceIds, matched, state.data, state.version, bundle.graph);
  if (!sameContextValue(bundle.assembly, expected.assembly) || !sameContextValue(bundle.evidence, expected.evidence)) throw new Error('연구 기준/선택 원문이 변경되었습니다. 다시 검색하세요.');
  const scope = { projectId: state.project.id, policyScope: state.policy?.scope ?? null, policyRevision: state.policy?.revision ?? null,
    policyHash: state.policy ? await hashText(JSON.stringify(state.policy)) : null,
    ...(!state.version ? { mode: 'project_only' as const } : {}) };
  if (bundle.projectScope ? !sameContextValue(parseRagProjectScope(bundle.projectScope), scope) : state.policy?.scope === 'research') throw new Error(CHANGED);
  // Detect a concurrent policy/source change while hashing, without sending any allow-list to the provider.
  const signature = JSON.stringify(state);
  if (signature !== JSON.stringify(await readState(bundle, db))) throw new Error(CHANGED);
  return signature;
}

export async function prepareRagProjectScope(bundle: ContextBundle, db: QaxiomDatabase = qaxiomDatabase, projectId = ''): Promise<ContextBundle> {
  const result = structuredClone(bundle);
  if (projectId && result.assembly?.research) throw new Error('정본 기준과 별도 프로젝트 범위를 동시에 선택할 수 없습니다.');
  if (projectId && !result.assembly?.research) {
    if (!result.assembly || result.graph) throw new Error('프로젝트 단독 미리보기에 검색 문맥이 없습니다.');
    result.projectScope = { projectId, mode: 'project_only', policyScope: null, policyRevision: null, policyHash: null };
  }
  const state = await readState(result, db);
  if (!state) return result;
  result.projectScope = { projectId: state.project.id, policyScope: state.policy?.scope ?? null, policyRevision: state.policy?.revision ?? null,
    policyHash: state.policy ? await hashText(JSON.stringify(state.policy)) : null,
    ...(!state.version ? { mode: 'project_only' as const } : {}) };
  await assertRagProjectScopeCurrent(result, db);
  return result;
}

export async function assertRagSearchScope(versionId: string, sourceIds: string[], db: QaxiomDatabase = qaxiomDatabase, projectId = '') {
  if (!versionId && !projectId) return;
  await db.transaction('r', [db.projects, db.theory_documents, db.document_versions], async () => {
    const version = versionId ? await db.document_versions.get(versionId) : null;
    const document = version && await db.theory_documents.get(version.documentId);
    const project = await db.projects.get(versionId ? document?.projectId ?? '' : projectId);
    if (!project || (versionId && document?.currentVersionId !== versionId)) throw new Error(CHANGED);
    if (project.sourcePolicy?.scope === 'research') assertProjectSources(project, sourceIds);
  });
}
