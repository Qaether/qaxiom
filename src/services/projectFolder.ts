import { qaxiomDatabase, type ProjectFolderRecord, type QaxiomDatabase } from './database';
import type { WorkspaceDirectoryHandle } from './folderExport';

export type FolderPermission = 'granted' | 'prompt' | 'denied';

export async function getActiveProjectFolder(database: QaxiomDatabase = qaxiomDatabase): Promise<ProjectFolderRecord | undefined> {
  const record = await database.project_folders.get('active');
  if (!record) return undefined;
  if (!record.name?.trim() || !record.folderName?.trim() || !record.directory) {
    throw new Error('저장된 프로젝트 폴더 정보가 올바르지 않습니다. 폴더를 다시 선택해 주세요.');
  }
  return record;
}

export async function listRecentProjectFolders(database: QaxiomDatabase = qaxiomDatabase): Promise<ProjectFolderRecord[]> {
  try {
    const records = await database.project_folders.toArray();
    const specific = records
      .filter(r => r.id !== 'active' && Boolean(r.name?.trim()) && Boolean(r.directory))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    if (specific.length > 0) return specific;

    const active = records.find(r => r.id === 'active');
    if (active && active.name?.trim() && active.directory) {
      return [active];
    }
    return [];
  } catch {
    return [];
  }
}

export async function rememberProjectFolder(
  project: { name: string; folderName: string; directory: WorkspaceDirectoryHandle },
  database: QaxiomDatabase = qaxiomDatabase
): Promise<ProjectFolderRecord> {
  const name = project.name.trim();
  const folderName = project.folderName.trim();
  if (!name || !folderName || !project.directory) throw new Error('프로젝트 이름과 로컬 폴더를 선택해 주세요.');
  const now = Date.now();
  const record: ProjectFolderRecord = { id: 'active', name, folderName, directory: project.directory, updatedAt: now };
  const specificId = projectFolderId(name);
  const specificRecord: ProjectFolderRecord = { id: specificId, name, folderName, directory: project.directory, updatedAt: now };
  try {
    await database.project_folders.put(record);
    await database.project_folders.put(specificRecord);
  } catch {
    throw new Error('이 브라우저에 폴더 연결 정보를 보존하지 못했습니다. 저장소 설정을 확인하고 다시 시도해 주세요.');
  }
  return record;
}

function projectFolderId(name: string): string {
  return `proj_${encodeURIComponent(name.toLowerCase())}`;
}

export async function renameProjectFolder(
  oldName: string,
  newName: string,
  database: QaxiomDatabase = qaxiomDatabase
): Promise<ProjectFolderRecord> {
  const trimmedOld = oldName.trim();
  const trimmedNew = newName.trim();
  if (!trimmedOld || !trimmedNew) {
    throw new Error('새 프로젝트 이름을 입력해 주세요.');
  }

  const oldId = projectFolderId(trimmedOld);
  const newId = projectFolderId(trimmedNew);
  const now = Date.now();

  return database.transaction('rw', database.project_folders, async () => {
    const existing = await database.project_folders.get(oldId);
    const active = await database.project_folders.get('active');
    const activeMatches = Boolean(active && active.name.trim().toLowerCase() === trimmedOld.toLowerCase());
    const source = existing ?? (activeMatches ? active : undefined);

    if (!source) {
      throw new Error('이름을 변경할 프로젝트를 찾을 수 없습니다.');
    }

    if (newId !== oldId) {
      const conflict = await database.project_folders.get(newId);
      if (conflict) {
        throw new Error('같은 이름의 프로젝트가 이미 있습니다.');
      }
    }

    const updatedSpecific: ProjectFolderRecord = {
      id: newId,
      name: trimmedNew,
      folderName: source.folderName,
      directory: source.directory,
      updatedAt: now
    };

    if (existing && newId !== oldId) {
      await database.project_folders.delete(oldId);
    }
    await database.project_folders.put(updatedSpecific);

    if (activeMatches && active) {
      await database.project_folders.put({
        ...active,
        id: 'active',
        name: trimmedNew,
        updatedAt: now
      });
    }

    return updatedSpecific;
  });
}

export async function deleteProjectFolder(
  name: string,
  database: QaxiomDatabase = qaxiomDatabase
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const specificId = projectFolderId(trimmed);

  await database.transaction('rw', database.project_folders, async () => {
    await database.project_folders.delete(specificId);
    const active = await database.project_folders.get('active');
    if (active && active.name.trim().toLowerCase() === trimmed.toLowerCase()) {
      await database.project_folders.delete('active');
    }
  });
}

export async function folderPermission(directory: WorkspaceDirectoryHandle): Promise<FolderPermission> {
  if (!directory.queryPermission) return 'prompt';
  try {
    return await directory.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'prompt';
  }
}

export async function requestFolderPermission(directory: WorkspaceDirectoryHandle): Promise<boolean> {
  if (await folderPermission(directory) === 'granted') return true;
  if (!directory.requestPermission) return false;
  try {
    return await directory.requestPermission({ mode: 'readwrite' }) === 'granted';
  } catch {
    return false;
  }
}
