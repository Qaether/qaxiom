// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { QaxiomDatabase } from '../database';
import { createTheory, loadTheory, saveTheoryVersion } from './documents';
import { EMPTY_CONTRACT } from './types';
import { listResearchProjects, moveTheoryProject, renameResearchProject, selectProjectCanonical } from './projects';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`projects-${crypto.randomUUID()}`); target = new QaxiomDatabase(`projects-target-${crypto.randomUUID()}`); });
afterEach(async () => { await db.delete(); await target.delete(); });
const create = (title: string) => createTheory({ title, markdown: `${title} original.`, contract: EMPTY_CONTRACT }, db);
it('renames organizational titles with conflict checks without changing document versions', async () => {
  const a = await create('A'); await renameResearchProject(a.document.projectId, 'A', '  Alpha  ', db);
  expect((await listResearchProjects(db))[0].title).toBe('Alpha');
  await expect(renameResearchProject(a.document.projectId, 'A', 'stale', db)).rejects.toThrow('변경');
  await expect(renameResearchProject(a.document.projectId, 'Alpha', '', db)).rejects.toThrow('1–200');
  expect((await loadTheory(a.document.id, db)).version).toEqual(a.version);
});
it('groups documents atomically and removes only empty source metadata', async () => {
  const a = await create('A'), b = await create('B');
  const saved = await moveTheoryProject(b, { projectId: a.document.projectId, canonicalDocumentId: a.document.id }, db);
  expect(saved.document.projectId).toBe(a.document.projectId); expect(saved.version).toEqual(b.version);
  expect(await db.projects.get(b.document.projectId)).toBeUndefined(); expect(await db.theory_documents.count()).toBe(2);
  expect((await listResearchProjects(db))[0].documentCount).toBe(2);
});
it('reassigns a moved representative and splits without transferring claims or changing immutable hashes', async () => {
  const a = await create('A'), b = await create('B');
  const grouped = await moveTheoryProject(b, { projectId: a.document.projectId, canonicalDocumentId: a.document.id }, db);
  await selectProjectCanonical(grouped, a.document.id, db);
  const split = await moveTheoryProject(grouped, { newTitle: 'Gamma' }, db);
  expect((await db.projects.get(a.document.projectId))!.canonicalDocumentId).toBe(a.document.id);
  expect((await db.projects.get(split.document.projectId))!.canonicalDocumentId).toBe(b.document.id);
  expect(split.history).toEqual(b.history); expect(split.blocks).toEqual(b.blocks);
});
it('rejects stale document versions, project membership and representative selection', async () => {
  const a = await create('A'), b = await create('B');
  const moved = await moveTheoryProject(b, { projectId: a.document.projectId, canonicalDocumentId: a.document.id }, db);
  await expect(moveTheoryProject(b, { newTitle: 'stale' }, db)).rejects.toThrow('변경');
  await selectProjectCanonical(moved, a.document.id, db);
  await expect(selectProjectCanonical(a, a.document.id, db)).rejects.toThrow('변경');
  await saveTheoryVersion(a.document.id, a.version.id, { title: 'A', markdown: 'A edited.', contract: EMPTY_CONTRACT }, db);
  await expect(moveTheoryProject(a, { newTitle: 'old version' }, db)).rejects.toThrow('변경');
});
it('rolls back destination creation, membership and representative changes on quota failure', async () => {
  const a = await create('A'); const fail = () => { throw new Error('quota'); };
  db.theory_documents.hook('updating', fail);
  await expect(moveTheoryProject(a, { newTitle: 'new' }, db)).rejects.toThrow('quota');
  db.theory_documents.hook('updating').unsubscribe(fail);
  expect(await db.projects.count()).toBe(1); expect((await loadTheory(a.document.id, db)).document).toEqual(a.document);
});
it('roundtrips multi-document projects and rejects cross-project representative corruption atomically', async () => {
  const a = await create('A'), b = await create('B'), c = await create('C');
  await moveTheoryProject(b, { projectId: a.document.projectId, canonicalDocumentId: a.document.id }, db);
  const bundle = await createWorkspaceBundle(db); await restoreWorkspaceBundle(JSON.parse(JSON.stringify(bundle)), target);
  expect((await listResearchProjects(target)).find(p => p.id === a.document.projectId)!.documentCount).toBe(2);
  const broken = structuredClone(bundle); broken.data.projects.find(p => p.id === a.document.projectId)!.canonicalDocumentId = c.document.id;
  await expect(restoreWorkspaceBundle(broken, target)).rejects.toThrow(); expect(await target.theory_documents.count()).toBe(3);
});
it('keeps existing one-document v16 projects compatible without a schema rewrite', async () => {
  const a = await create('A'); const bundle = await createWorkspaceBundle(db); expect(bundle.version).toBe(22);
  await restoreWorkspaceBundle(bundle, target); expect(target.verno).toBe(23);
  expect((await listResearchProjects(target))[0].canonicalDocumentId).toBe(a.document.id);
});
