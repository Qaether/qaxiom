import type { QaxiomDatabase } from '../database';
import { loadTheory } from './documents';
import type { ProjectSourcePolicy, TheorySnapshot } from './types';

// Test-only fixtures for pre-existing project records. These are not application commands.
export async function seedLegacyPolicy(snapshot: TheorySnapshot, expectedRevision: number | null, sourceIds: string[], db: QaxiomDatabase,
  scope: ProjectSourcePolicy['scope'] = 'external_review') {
  const policy: ProjectSourcePolicy = { scope, revision: (expectedRevision ?? 0) + 1, allowedSourceIds: [...sourceIds].sort() };
  await db.projects.update(snapshot.document.projectId, { sourcePolicy: policy });
  return policy;
}

export async function seedLegacyProjectMove(snapshot: TheorySnapshot,
  destination: { projectId: string; canonicalDocumentId: string } | { newTitle: string }, db: QaxiomDatabase) {
  const sourceId = snapshot.document.projectId;
  const siblings = (await db.theory_documents.where('projectId').equals(sourceId).toArray()).filter(row => row.id !== snapshot.document.id);
  const source = await db.projects.get(sourceId);
  if (!source) throw new Error('Fixture source project missing');
  let targetId: string;
  if ('projectId' in destination) {
    targetId = destination.projectId;
  } else {
    targetId = crypto.randomUUID();
    await db.projects.add({ id: targetId, title: destination.newTitle, canonicalDocumentId: snapshot.document.id,
      createdAt: Date.now(), ...(source.sourcePolicy ? { sourcePolicy: { ...source.sourcePolicy, revision: 1 } } : {}) });
  }
  await db.theory_documents.update(snapshot.document.id, { projectId: targetId });
  if (!siblings.length) await db.projects.delete(sourceId);
  else if (source.canonicalDocumentId === snapshot.document.id) await db.projects.update(sourceId, { canonicalDocumentId: siblings[0].id });
  return loadTheory(snapshot.document.id, db);
}
