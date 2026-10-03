import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { loadTheory } from './documents';
import type { TheorySnapshot } from './types';

const titleValue = (title: string) => {
  if (!title.trim() || title.trim().length > 200) throw new Error('프로젝트 이름은 1–200자로 입력하세요.');
  return title.trim();
};
export async function listResearchProjects(db: QaxiomDatabase = qaxiomDatabase) {
  return db.transaction('r', [db.projects, db.theory_documents], async () => {
    const projects = await db.projects.orderBy('createdAt').toArray(), documents = await db.theory_documents.toArray();
    return projects.map(project => ({ ...project, documentCount: documents.filter(d => d.projectId === project.id).length }));
  });
}
export async function renameResearchProject(id: string, expectedTitle: string, title: string, db: QaxiomDatabase = qaxiomDatabase) {
  const next = titleValue(title);
  await db.transaction('rw', db.projects, async () => {
    const project = await db.projects.get(id);
    if (!project || project.title !== expectedTitle) throw new Error('프로젝트 이름이 변경되었습니다. 다시 열어 확인하세요.');
    await db.projects.update(id, { title: next });
  });
}

/** Changes organizational membership only; never merges versions, claims, contracts or evidence. */
export async function moveTheoryProject(snapshot: TheorySnapshot, destination: { projectId: string; canonicalDocumentId: string } | { newTitle: string }, db: QaxiomDatabase = qaxiomDatabase) {
  const newTitle = 'newTitle' in destination ? titleValue(destination.newTitle) : null;
  await db.transaction('rw', [db.projects, db.theory_documents], async () => {
    const document = await db.theory_documents.get(snapshot.document.id);
    if (!document || document.projectId !== snapshot.document.projectId || document.currentVersionId !== snapshot.version.id) throw new Error('문서 버전/프로젝트가 변경되었습니다. 다시 열어 확인하세요.');
    const source = await db.projects.get(document.projectId);
    if (!source || (await db.theory_documents.get(source.canonicalDocumentId))?.projectId !== source.id) throw new Error('출발 프로젝트의 대표 문서 참조가 올바르지 않습니다.');
    const siblings = (await db.theory_documents.where('projectId').equals(source.id).toArray()).filter(d => d.id !== document.id).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    let targetId: string;
    if ('projectId' in destination) {
      const target = await db.projects.get(destination.projectId);
      if (!target || target.canonicalDocumentId !== destination.canonicalDocumentId || (await db.theory_documents.get(target.canonicalDocumentId))?.projectId !== target.id) throw new Error('도착 프로젝트의 대표 문서가 변경되었습니다. 다시 확인하세요.');
      if (source.id === target.id) return;
      if (await db.theory_documents.where('projectId').equals(target.id).count() >= 500) throw new Error('프로젝트 문서는 최대 500개입니다.');
      targetId = target.id;
    } else {
      if (siblings.length && await db.projects.count() >= 1000) throw new Error('프로젝트는 최대 1,000개입니다.');
      targetId = crypto.randomUUID();
      await db.projects.add({ id: targetId, title: newTitle!, canonicalDocumentId: document.id, createdAt: Date.now(), ...(source.sourcePolicy ? { sourcePolicy: { ...source.sourcePolicy, revision: 1, allowedSourceIds: [...source.sourcePolicy.allowedSourceIds] } } : {}) });
    }
    await db.theory_documents.update(document.id, { projectId: targetId });
    if (!siblings.length) await db.projects.delete(source.id);
    else if (source.canonicalDocumentId === document.id) await db.projects.update(source.id, { canonicalDocumentId: siblings[0].id });
  });
  return loadTheory(snapshot.document.id, db);
}
export async function selectProjectCanonical(snapshot: TheorySnapshot, expectedCanonicalId: string, db: QaxiomDatabase = qaxiomDatabase) {
  await db.transaction('rw', [db.projects, db.theory_documents], async () => {
    const document = await db.theory_documents.get(snapshot.document.id), project = await db.projects.get(snapshot.document.projectId);
    if (!document || document.projectId !== snapshot.document.projectId || document.currentVersionId !== snapshot.version.id || !project || project.canonicalDocumentId !== expectedCanonicalId) throw new Error('프로젝트/문서가 변경되었습니다. 다시 확인하세요.');
    await db.projects.update(project.id, { canonicalDocumentId: document.id });
  });
}
