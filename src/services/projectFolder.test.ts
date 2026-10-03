import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QaxiomDatabase } from './database';
import { folderPermission, getActiveProjectFolder, rememberProjectFolder, requestFolderPermission } from './projectFolder';
import type { WorkspaceDirectoryHandle } from './folderExport';

let database: QaxiomDatabase;
beforeEach(() => { database = new QaxiomDatabase(`project-folder-${crypto.randomUUID()}`); });
afterEach(async () => { await database.delete(); });

it('remembers the selected project and folder in a new additive table', async () => {
  const directory = { name: 'study-folder' } as WorkspaceDirectoryHandle;
  await rememberProjectFolder({ name: '  연구 A  ', folderName: 'study-folder', directory }, database);
  const active = await getActiveProjectFolder(database);
  expect(active?.id).toBe('active');
  expect(active?.name).toBe('연구 A');
  expect(active?.folderName).toBe('study-folder');
  expect(active?.directory).toEqual(directory);
  expect(typeof active?.updatedAt).toBe('number');
  database.close();
  const reopened = new QaxiomDatabase(database.name);
  expect((await getActiveProjectFolder(reopened))?.folderName).toBe('study-folder');
  await reopened.delete();
});

it('lists multiple recent project folders', async () => {
  const dir1 = { name: 'dir-1' } as WorkspaceDirectoryHandle;
  const dir2 = { name: 'dir-2' } as WorkspaceDirectoryHandle;
  await rememberProjectFolder({ name: 'Project 1', folderName: 'dir-1', directory: dir1 }, database);
  await rememberProjectFolder({ name: 'Project 2', folderName: 'dir-2', directory: dir2 }, database);
  const { listRecentProjectFolders } = await import('./projectFolder');
  const recent = await listRecentProjectFolders(database);
  expect(recent.length).toBe(2);
  expect(recent[0].name).toBe('Project 2');
  expect(recent[1].name).toBe('Project 1');
});

it('asks again when permission is not available and never treats denial as granted', async () => {
  const queryPermission = vi.fn().mockResolvedValue('prompt');
  const requestPermission = vi.fn().mockResolvedValueOnce('denied').mockResolvedValueOnce('granted');
  const directory: WorkspaceDirectoryHandle = { queryPermission, requestPermission, async getFileHandle() { throw new Error('not used'); } };
  expect(await folderPermission(directory)).toBe('prompt');
  expect(await requestFolderPermission(directory)).toBe(false);
  expect(await requestFolderPermission(directory)).toBe(true);
  expect(queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
  expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
});
