// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseWorkspaceDirectory, workspaceDirectoryPicker, writeTheoryDocumentsToDirectory, writeWorkspaceBackupToDirectory, type WorkspaceDirectoryHandle, type WorkspaceFileWriter } from './folderExport';
import { QaxiomDatabase } from './database';
import { createWorkspaceBundle } from './workspace';
import { createTheory, saveTheoryVersion } from './theory/documents';
import { EMPTY_CONTRACT } from './theory/types';

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const files = new Map<string, string>();
  const removed: string[] = [];
  let failWrite = false;
  let aborts = 0;
  const directory: WorkspaceDirectoryHandle = {
    async getFileHandle(name, options) {
      if (!options?.create && !files.has(name)) throw new DOMException('Missing', 'NotFoundError');
      if (options?.create && !files.has(name)) files.set(name, '');
      return {
        async createWritable() {
          let next = '';
          const writer: WorkspaceFileWriter = {
            async write(value) { if (failWrite) throw new Error('disk full'); next = value; },
            async close() { files.set(name, next); },
            async abort() { aborts++; }
          };
          return writer;
        }
      };
    },
    async removeEntry(name) { files.delete(name); removed.push(name); }
  };
  return { files, removed, directory, failNextWrite: () => { failWrite = true; }, get aborts() { return aborts; } };
}

describe('explicit folder backup', () => {
  it('writes a fresh JSON file and never replaces a colliding name', async () => {
    const target = fixture();
    const now = new Date('2026-10-03T12:34:56.000Z');
    const first = await writeWorkspaceBackupToDirectory(target.directory, '{"version":22}', { now, createId: () => 'same' });
    const names = ['same', 'different'];
    const second = await writeWorkspaceBackupToDirectory(target.directory, '{"version":23}', { now, createId: () => names.shift()! });
    expect(first).toBe('qaxiom-workspace-20261003-123456-same.json');
    expect(second).toBe('qaxiom-workspace-20261003-123456-different.json');
    expect(target.files.get(first)).toBe('{"version":22}');
    expect(target.files.get(second)).toBe('{"version":23}');
  });

  it('aborts and removes only the newly created file when writing fails', async () => {
    const target = fixture();
    target.files.set('older.json', 'keep');
    target.failNextWrite();
    await expect(writeWorkspaceBackupToDirectory(target.directory, 'backup', { createId: () => 'failed' })).rejects.toThrow('disk full');
    expect(target.aborts).toBe(1);
    expect(target.removed).toHaveLength(1);
    expect(target.files.get('older.json')).toBe('keep');
    expect(target.files.size).toBe(1);
  });

  it('does not open a directory when unsupported or after picker cancellation', async () => {
    vi.stubGlobal('isSecureContext', false);
    expect(workspaceDirectoryPicker()).toBeNull();
    await expect(chooseWorkspaceDirectory()).rejects.toThrow('지원하지 않습니다');
    vi.stubGlobal('isSecureContext', true);
    const picker = vi.fn().mockRejectedValue(new DOMException('cancel', 'AbortError'));
    vi.stubGlobal('showDirectoryPicker', picker);
    await expect(chooseWorkspaceDirectory()).rejects.toThrow('취소했습니다');
    expect(picker).toHaveBeenCalledWith({ mode: 'readwrite' });
    picker.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await expect(chooseWorkspaceDirectory()).rejects.toThrow('권한이 거부되었습니다');
  });
});

function folderFixture() {
  const folders = new Map<string, Map<string, string>>();
  let failManifest = false;
  const directory: WorkspaceDirectoryHandle = {
    async getFileHandle() { throw new Error('root files are not used'); },
    async getDirectoryHandle(name, options) {
      let files = folders.get(name);
      if (!files && !options?.create) throw new DOMException('Missing', 'NotFoundError');
      if (!files) { files = new Map(); folders.set(name, files); }
      const target = files;
      return {
        async getFileHandle(filename) {
          return { async createWritable() {
            let content = '';
            return {
              async write(value: string) { if (failManifest && filename === 'manifest.json') throw new Error('manifest denied'); content = value; },
              async close() { target.set(filename, content); },
              async abort() { content = ''; }
            };
          } };
        }
      };
    },
    async removeEntry(name) { folders.delete(name); }
  };
  return { directory, folders, failManifest: () => { failManifest = true; } };
}

describe('current theory Markdown folder export', () => {
  it('writes only current versions and a provenance manifest in a fresh folder', async () => {
    const db = new QaxiomDatabase(`folder-export-${crypto.randomUUID()}`);
    try {
      const first = await createTheory({ title: '수학 정의', markdown: '# 오래된 본문', contract: { ...EMPTY_CONTRACT } }, db);
      const latest = await saveTheoryVersion(first.document.id, first.version.id,
        { title: '수학 정의', markdown: '# 최신 본문', contract: { ...EMPTY_CONTRACT } }, db);
      const bundle = await createWorkspaceBundle(db);
      const target = folderFixture();
      const result = await writeTheoryDocumentsToDirectory(target.directory, bundle,
        { now: new Date('2026-10-03T12:34:56.000Z'), createId: () => 'new-folder' });
      expect(result.documentCount).toBe(1);
      const files = target.folders.get(result.folderName)!;
      expect(files.size).toBe(2);
      const markdownName = [...files.keys()].find(name => name.endsWith('.md'))!;
      expect(files.get(markdownName)).toBe('# 최신 본문');
      const manifest = JSON.parse(files.get('manifest.json')!);
      expect(manifest.scope).toBe('current-theory-versions-only');
      expect(manifest.documents[0]).toMatchObject({ file: markdownName, documentId: first.document.id,
        versionId: latest.version.id, versionNumber: 2, markdownHash: latest.version.contentHash });
    } finally { await db.delete(); }
  });

  it('rejects a changed document before creating a folder and cleans a new partial folder on failure', async () => {
    const db = new QaxiomDatabase(`folder-export-${crypto.randomUUID()}`);
    try {
      await createTheory({ title: '문서', markdown: '# 원문', contract: { ...EMPTY_CONTRACT } }, db);
      const bundle = await createWorkspaceBundle(db);
      const target = folderFixture();
      const correctHash = bundle.data.documentVersions[0].contentHash;
      bundle.data.documentVersions[0].contentHash = '0'.repeat(64);
      await expect(writeTheoryDocumentsToDirectory(target.directory, bundle)).rejects.toThrow('해시');
      expect(target.folders.size).toBe(0);
      bundle.data.documentVersions[0].contentHash = correctHash;
      target.failManifest();
      await expect(writeTheoryDocumentsToDirectory(target.directory, bundle)).rejects.toThrow('manifest denied');
      expect(target.folders.size).toBe(0);
    } finally { await db.delete(); }
  });
});
