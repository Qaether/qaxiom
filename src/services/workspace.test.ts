// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QaxiomDatabase, resetPersistenceState } from './database';
import { createTheory, loadTheory, saveTheoryVersion } from './theory/documents';
import { EMPTY_CONTRACT } from './theory/types';
import {
  createWorkspaceBundle,
  parseWorkspaceBundle,
  restoreWorkspaceBundle,
  serializeWorkspaceBundle
} from './workspace';

let source: QaxiomDatabase;
let target: QaxiomDatabase;

beforeEach(() => {
  source = new QaxiomDatabase(`qaxiom-export-${crypto.randomUUID()}`);
  target = new QaxiomDatabase(`qaxiom-import-${crypto.randomUUID()}`);
  resetPersistenceState();
});

afterEach(async () => {
  source.close();
  target.close();
  await source.delete();
  await target.delete();
  resetPersistenceState();
});

async function seedWorkspace(database: QaxiomDatabase): Promise<void> {
  await database.sessions.add({
    id: 'session-1',
    position: 0,
    title: '연구 백업',
    createdAt: 1,
    updatedAt: 2,
    researchMode: 'general',
    selectedModel: 'gemini-3.8-flash'
  });
  await database.messages.add({
    id: 'message-1',
    sessionId: 'session-1',
    position: 0,
    role: 'user',
    content: '백업 질문',
    timestamp: 2
  });
  await database.documents.add({
    id: 'document-1',
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    size: 42,
    createdAt: 3,
    updatedAt: 4,
    status: 'ready'
  });
  await database.document_chunks.add({
    id: 'chunk-1',
    documentId: 'document-1',
    position: 0,
    page: 1,
    text: '문서 본문'
  });
  await database.wiki_pages.add({
    id: 'wiki-1',
    title: '개념',
    summary: '요약',
    content: '내용',
    tags: ['연구'],
    backlinks: [],
    createdAt: 5,
    updatedAt: 6
  });
  await database.source_spans.add({
    id: 'span-1',
    documentId: 'document-1',
    wikiPageId: 'wiki-1',
    page: 1,
    startOffset: 0,
    endOffset: 5,
    quote: '문서 본문'
  });
  await database.jobs.add({
    id: 'job-1',
    type: 'document-ingestion',
    status: 'complete',
    createdAt: 7,
    updatedAt: 8
  });
}

describe('versioned workspace bundles', () => {
  it('round-trips a document-linked session and its pinned request snapshot', async () => {
    const snapshot = await createTheory({ title: '정본', markdown: '# 전제\n\nA', contract: { ...EMPTY_CONTRACT } }, source);
    const { captureDocumentContext } = await import('./documentChat');
    const context = await captureDocumentContext(snapshot.document.id, null, source);
    await source.sessions.add({ id: 'linked', documentId: snapshot.document.id, position: 0, title: '검토',
      createdAt: 1, updatedAt: 1, researchMode: 'general', selectedModel: 'gemini-3.8-flash' });
    await source.messages.add({ id: 'answer', sessionId: 'linked', position: 0, role: 'assistant',
      content: '답변', timestamp: 1, documentContext: context });
    const bundle = await createWorkspaceBundle(source);
    await restoreWorkspaceBundle(bundle, target);
    expect((await target.sessions.get('linked'))?.documentId).toBe(snapshot.document.id);
    expect((await target.messages.get(['linked', 'answer']))?.documentContext).toEqual(context);
    const corrupted = structuredClone(bundle);
    corrupted.data.messages[0].documentContext!.markdown = '변조';
    await expect(restoreWorkspaceBundle(corrupted, target)).rejects.toThrow('hash');
  });

  it('round-trips canonical revisions, contracts and block lineage in the current backup', async () => {
    const input = { title: '정본', markdown: '# 가정\n\nx > 0', contract: { ...EMPTY_CONTRACT, scope: '실수' } };
    const first = await createTheory(input, source);
    const second = await saveTheoryVersion(first.document.id, first.version.id, { ...input, markdown: '# 가정\n\nx > 1' }, source);
    const bundle = await createWorkspaceBundle(source);
    expect(bundle.version).toBe(24);
    await restoreWorkspaceBundle(JSON.parse(serializeWorkspaceBundle(bundle)), target);
    expect(await loadTheory(first.document.id, target)).toEqual(second);
    expect((await createWorkspaceBundle(target)).data).toEqual(bundle.data);
  });

  it('imports a v1 backup into the new schema, clearing newer theory data as part of full replacement', async () => {
    await seedWorkspace(source);
    await createTheory({ title: '교체 대상', markdown: '본문', contract: { ...EMPTY_CONTRACT } }, target);
    const bundle = await createWorkspaceBundle(source);
    const { projects: _p, theoryDocuments: _d, documentVersions: _v, documentBlocks: _b, ...v1Data } = bundle.data;
    await restoreWorkspaceBundle({ ...bundle, version: 1, data: v1Data }, target);
    expect(await target.sessions.count()).toBe(1);
    expect(await target.theory_documents.count()).toBe(0);
    expect(await target.document_versions.count()).toBe(0);
  });

  it('rejects altered hashes and cross-document ancestry before clearing the target', async () => {
    const input = { title: '정본', markdown: '# 가정\n\nx > 0', contract: { ...EMPTY_CONTRACT } };
    await createTheory(input, source);
    const keep = await createTheory(input, target);
    const bundle = await createWorkspaceBundle(source);
    bundle.data.documentVersions[0].contentHash = 'tampered';
    await expect(restoreWorkspaceBundle(bundle, target)).rejects.toThrow('해시');
    expect((await loadTheory(keep.document.id, target)).version.id).toBe(keep.version.id);
    bundle.data.theoryDocuments[0].currentVersionId = 'missing';
    await expect(restoreWorkspaceBundle(bundle, target)).rejects.toThrow('참조');
    expect(await target.theory_documents.count()).toBe(1);
  });

  it('rolls back every table on a restore write failure', async () => {
    await seedWorkspace(source);
    const keep = await createTheory({ title: '보존', markdown: '본문', contract: { ...EMPTY_CONTRACT } }, target);
    const failure = () => { throw new Error('restore write failed'); };
    target.messages.hook('creating', failure);
    await expect(restoreWorkspaceBundle(await createWorkspaceBundle(source), target)).rejects.toThrow('restore write failed');
    target.messages.hook('creating').unsubscribe(failure);
    expect((await loadTheory(keep.document.id, target)).version.id).toBe(keep.version.id);
    expect(await target.sessions.count()).toBe(0);
  });

  it('round-trips every workspace table and includes a Markdown companion', async () => {
    await seedWorkspace(source);
    const bundle = await createWorkspaceBundle(source);

    await restoreWorkspaceBundle(JSON.parse(serializeWorkspaceBundle(bundle)), target);
    const restored = await createWorkspaceBundle(target);

    expect(restored.data).toEqual(bundle.data);
    expect(bundle.markdown).toHaveLength(1);
    expect(bundle.markdown[0]?.filename).toBe('연구_백업.md');
    expect(bundle.markdown[0]?.content).toContain('백업 질문');
  });

  it('does not include settings or API-key fields', async () => {
    await seedWorkspace(source);
    const serialized = serializeWorkspaceBundle(await createWorkspaceBundle(source));

    expect(serialized).not.toContain('apiKeys');
    expect(serialized).not.toContain('customKey');
  });

  it('rejects unsupported versions before changing the destination', async () => {
    await seedWorkspace(source);
    await target.sessions.add({
      id: 'keep-me',
      position: 0,
      title: '보존',
      createdAt: 1,
      updatedAt: 1,
      researchMode: 'general',
      selectedModel: 'gemini-3.8-flash'
    });
    const invalid = { ...(await createWorkspaceBundle(source)), version: 999 };

    await expect(restoreWorkspaceBundle(invalid, target)).rejects.toThrow('지원하지 않는');
    expect(await target.sessions.get('keep-me')).toBeTruthy();
  });

  it('rejects broken references without partially clearing existing data', async () => {
    await seedWorkspace(source);
    await target.sessions.add({
      id: 'keep-me',
      position: 0,
      title: '보존',
      createdAt: 1,
      updatedAt: 1,
      researchMode: 'general',
      selectedModel: 'gemini-3.8-flash'
    });
    const invalid = await createWorkspaceBundle(source);
    invalid.data.messages[0]!.sessionId = 'missing-session';

    expect(() => parseWorkspaceBundle(invalid)).toThrow('존재하지 않는 세션');
    await expect(restoreWorkspaceBundle(invalid, target)).rejects.toThrow('존재하지 않는 세션');
    expect(await target.sessions.get('keep-me')).toBeTruthy();
    expect(await target.messages.count()).toBe(0);
  });
});
