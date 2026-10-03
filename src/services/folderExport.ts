import type { WorkspaceBundle } from './workspace';
import { parseTheoryData, verifyTheoryHashes } from './theory/validation';

export interface WorkspaceFileWriter {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface WorkspaceFileHandle {
  createWritable(): Promise<WorkspaceFileWriter>;
}

export interface WorkspaceDirectoryHandle {
  name?: string;
  queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WorkspaceFileHandle>;
  getDirectoryHandle?(name: string, options?: { create?: boolean }): Promise<WorkspaceDirectoryHandle>;
  removeEntry?(name: string, options?: { recursive?: boolean }): Promise<void>;
}

type DirectoryPicker = (options: { mode: 'readwrite' }) => Promise<WorkspaceDirectoryHandle>;

export function workspaceDirectoryPicker(): DirectoryPicker | null {
  const picker = (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  return window.isSecureContext && typeof picker === 'function' ? picker.bind(window) : null;
}

export async function chooseWorkspaceDirectory(): Promise<WorkspaceDirectoryHandle> {
  const picker = workspaceDirectoryPicker();
  if (!picker) throw new Error('이 브라우저에서는 폴더 저장을 지원하지 않습니다. 작업공간 백업 다운로드를 사용하세요.');
  try {
    return await picker({ mode: 'readwrite' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('폴더 선택을 취소했습니다. 작업공간은 변경되지 않았습니다.');
    if (error instanceof DOMException && error.name === 'NotAllowedError') throw new Error('폴더 접근 권한이 거부되었습니다. 작업공간 백업 다운로드를 사용하거나 다시 허용하세요.');
    throw error;
  }
}

function backupName(now: Date, id: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `qaxiom-workspace-${stamp}-${id}.json`;
}

/** Writes a fresh, uniquely named backup. It never intentionally opens an existing file for writing. */
export async function writeWorkspaceBackupToDirectory(
  directory: WorkspaceDirectoryHandle,
  json: string,
  options: { now?: Date; createId?: () => string } = {}
): Promise<string> {
  if (!json.trim()) throw new Error('빈 작업공간 백업은 저장할 수 없습니다.');
  const createId = options.createId ?? (() => crypto.randomUUID());
  let name = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    name = backupName(options.now ?? new Date(), createId());
    try {
      await directory.getFileHandle(name);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') break;
      throw error;
    }
    name = '';
  }
  if (!name) throw new Error('겹치지 않는 백업 파일명을 만들지 못했습니다.');

  // A random suffix and an existence check avoid replacing an earlier backup.
  const file = await directory.getFileHandle(name, { create: true });
  let writer: WorkspaceFileWriter | undefined;
  try {
    writer = await file.createWritable();
    await writer.write(json);
    await writer.close();
  } catch (error) {
    try { await writer?.abort(); } catch { /* keep the original failure */ }
    let cleaned = false;
    try {
      if (directory.removeEntry) { await directory.removeEntry(name); cleaned = true; }
    } catch { /* the partial file may remain */ }
    const detail = error instanceof Error ? error.message : '알 수 없는 쓰기 오류';
    throw new Error(`폴더 백업에 실패했습니다: ${detail}${cleaned ? '' : `. ${name} 임시 파일이 남았는지 확인하세요.`}`);
  }
  return name;
}

function safePart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9가-힣_-]/g, '_').slice(0, 80) || 'untitled';
}

async function writeNewFile(directory: WorkspaceDirectoryHandle, name: string, content: string): Promise<void> {
  const file = await directory.getFileHandle(name, { create: true });
  const writer = await file.createWritable();
  try {
    await writer.write(content);
    await writer.close();
  } catch (error) {
    try { await writer.abort(); } catch { /* retain the write failure */ }
    throw error;
  }
}

/** Exports only current theory versions as plain Markdown; complete history stays in workspace JSON. */
export async function writeTheoryDocumentsToDirectory(
  parent: WorkspaceDirectoryHandle,
  bundle: WorkspaceBundle,
  options: { now?: Date; createId?: () => string } = {}
): Promise<{ folderName: string; documentCount: number }> {
  if (!parent.getDirectoryHandle || !parent.removeEntry) throw new Error('이 브라우저는 안전한 폴더 내보내기를 지원하지 않습니다.');
  parseTheoryData(bundle.data, true);
  await verifyTheoryHashes(bundle.data);
  const versions = new Map(bundle.data.documentVersions.map(version => [version.id, version]));
  const projects = new Map(bundle.data.projects.map(project => [project.id, project]));
  const entries = bundle.data.theoryDocuments.map(document => {
    const version = versions.get(document.currentVersionId);
    const project = projects.get(document.projectId);
    if (!version || version.documentId !== document.id || !project) throw new Error('문서의 현재 버전 또는 프로젝트가 올바르지 않아 내보내기를 중단했습니다.');
    return { document, version, project, file: `${safePart(version.title)}-${safePart(document.id)}-v${version.number}.md` };
  });
  if (!entries.length) throw new Error('폴더로 내보낼 연구 문서가 없습니다.');
  if (new Set(entries.map(entry => entry.file)).size !== entries.length) throw new Error('내보낼 문서 파일명이 중복됩니다.');

  const now = options.now ?? new Date();
  const createId = options.createId ?? (() => crypto.randomUUID());
  let folderName = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `qaxiom-documents-${now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${safePart(createId())}`;
    try {
      await parent.getDirectoryHandle(candidate);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') { folderName = candidate; break; }
      throw error;
    }
  }
  if (!folderName) throw new Error('겹치지 않는 문서 폴더명을 만들지 못했습니다.');

  const directory = await parent.getDirectoryHandle(folderName, { create: true });
  try {
    for (const entry of entries) await writeNewFile(directory, entry.file, entry.version.markdown);
    const manifest = {
      format: 'qaxiom-theory-markdown-export', version: 1, exportedAt: now.toISOString(),
      scope: 'current-theory-versions-only',
      documents: entries.map(entry => ({ file: entry.file, documentId: entry.document.id, projectId: entry.project.id,
        projectTitle: entry.project.title, versionId: entry.version.id, versionNumber: entry.version.number,
        markdownHash: entry.version.contentHash }))
    };
    await writeNewFile(directory, 'manifest.json', JSON.stringify(manifest, null, 2));
  } catch (error) {
    let cleaned = false;
    try { await parent.removeEntry(folderName, { recursive: true }); cleaned = true; } catch { /* partial folder may remain */ }
    const detail = error instanceof Error ? error.message : '알 수 없는 쓰기 오류';
    throw new Error(`문서 폴더 내보내기에 실패했습니다: ${detail}${cleaned ? '' : `. ${folderName} 부분 폴더가 남았는지 확인하세요.`}`);
  }
  return { folderName, documentCount: entries.length };
}
