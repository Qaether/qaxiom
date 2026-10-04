import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QaxiomDatabase } from '../database';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { createTheory, loadTheory, saveTheoryVersion } from './documents';
import { seedLegacyProjectMove as moveTheoryProject } from './legacyProjectFixtures';
import { runLocalReview } from './reviews';
import { deleteTheory, prepareTheoryDeletion } from './theoryDeletion';
import { EMPTY_CONTRACT } from './types';

let db: QaxiomDatabase;
let target: QaxiomDatabase;
const input = (title = '시험 문서') => ({ title, markdown: '# 가정\n\nA > 0', contract: { ...EMPTY_CONTRACT } });
beforeEach(() => { db = new QaxiomDatabase(`theory-delete-${crypto.randomUUID()}`); target = new QaxiomDatabase(`theory-delete-restore-${crypto.randomUUID()}`); });
afterEach(async () => { await db.delete(); await target.delete(); });

describe('research document deletion', () => {
  it('removes an empty document chat but blocks deletion while that chat has messages', async () => {
    const snapshot = await createTheory(input(), db);
    await db.sessions.add({ id: 'linked', documentId: snapshot.document.id, position: 0, title: '새로운 연구 대화',
      createdAt: 1, updatedAt: 1, researchMode: 'general', selectedModel: 'gemini-3.8-flash' });
    const preview = await prepareTheoryDeletion(snapshot.document.id, snapshot.version.id, db);
    await db.messages.add({ sessionId: 'linked', id: 'question', position: 0, role: 'user', content: '질문', timestamp: 1 });
    await expect(deleteTheory(preview, db)).rejects.toThrow('대화가 남아');
    await db.messages.clear();
    await deleteTheory(preview, db);
    expect(await db.sessions.get('linked')).toBeUndefined();
  });

  it('removes own versions, blocks, reviews and campaign atomically while preserving unrelated data and valid backup', async () => {
    const first = await createTheory(input(), db);
    const second = await saveTheoryVersion(first.document.id, first.version.id, { ...input(), markdown: '# 가정\n\nA > 1' }, db);
    await runLocalReview(second, db);
    await db.review_campaigns.add({ id: 'campaign', documentId: first.document.id, activeDocumentId: first.document.id,
      createdAt: 1, maxRequests: 3, maxElapsedMs: 360000, attempts: [], plan: null });
    const unrelated = await createTheory(input('남길 문서'), db);
    const preview = await prepareTheoryDeletion(first.document.id, second.version.id, db);
    expect(preview.versionCount).toBe(2); expect(preview.reviewCount).toBe(1); expect(preview.projectAction).toBe('remove');
    await deleteTheory(preview, db);
    expect(await db.theory_documents.get(first.document.id)).toBeUndefined();
    expect(await db.document_versions.where('documentId').equals(first.document.id).count()).toBe(0);
    expect(await db.document_blocks.where('documentId').equals(first.document.id).count()).toBe(0);
    expect(await db.review_runs.where('documentId').equals(first.document.id).count()).toBe(0);
    expect(await db.review_campaigns.where('documentId').equals(first.document.id).count()).toBe(0);
    expect(await db.projects.get(first.document.projectId)).toBeUndefined();
    expect((await loadTheory(unrelated.document.id, db)).version.title).toBe('남길 문서');
    await restoreWorkspaceBundle(await createWorkspaceBundle(db), target);
    expect((await loadTheory(unrelated.document.id, target)).version.title).toBe('남길 문서');
  });

  it('moves the representative pointer when a shared project loses its representative document', async () => {
    const first = await createTheory(input('A'), db), second = await createTheory(input('B'), db);
    await moveTheoryProject(second, { projectId: first.document.projectId, canonicalDocumentId: first.document.id }, db);
    const preview = await prepareTheoryDeletion(first.document.id, first.version.id, db);
    expect(preview.projectAction).toBe('choose_representative');
    await deleteTheory(preview, db);
    expect((await db.projects.get(first.document.projectId))?.canonicalDocumentId).toBe(second.document.id);
    expect((await loadTheory(second.document.id, db)).document.projectId).toBe(first.document.projectId);
  });

  it('blocks pinned answers, derivative references, active requests and changed previews', async () => {
    const first = await createTheory(input(), db);
    const preview = await prepareTheoryDeletion(first.document.id, first.version.id, db);
    await db.messages.add({ sessionId: 'test', id: 'message', position: 0, role: 'assistant', content: '답변', timestamp: 1,
      contextBundle: { assembly: { research: { documentId: first.document.id } } } } as never);
    await expect(deleteTheory(preview, db)).rejects.toThrow('참조 중');
    await db.messages.clear();
    await db.references.add({ id: 'derived', name: 'snapshot.md', text: 'A > 0', contentHash: 'hash', role: 'theory_snapshot',
      originVersionId: first.version.id, createdAt: 1, parserVersion: 'text-v1' });
    await expect(prepareTheoryDeletion(first.document.id, first.version.id, db)).rejects.toThrow('레퍼런스');
    await db.references.clear();
    await db.external_claims.add({ id: 'claim', documentId: first.document.id } as never);
    await expect(prepareTheoryDeletion(first.document.id, first.version.id, db)).rejects.toThrow('외부 주장');
    await db.external_claims.clear();
    await db.review_campaigns.add({ id: 'active', documentId: first.document.id, activeDocumentId: first.document.id,
      createdAt: 1, maxRequests: 3, maxElapsedMs: 360000, plan: null,
      attempts: [{ token: 'token', versionId: first.version.id, modelId: 'test', blockIds: [], startedAt: 1,
        deadlineAt: 120001, elapsedMs: 0, runId: null }] });
    await expect(prepareTheoryDeletion(first.document.id, first.version.id, db)).rejects.toThrow('종료되지 않은');
    await db.review_campaigns.clear();
    await saveTheoryVersion(first.document.id, first.version.id, { ...input(), markdown: 'A > 1' }, db);
    await expect(deleteTheory(preview, db)).rejects.toThrow('변경');
    expect(await db.theory_documents.get(first.document.id)).toBeTruthy();
  });

  it('rolls back all removals if a database delete fails', async () => {
    const first = await createTheory(input(), db);
    const preview = await prepareTheoryDeletion(first.document.id, first.version.id, db);
    const fail = () => { throw new Error('injected delete failure'); };
    db.theory_documents.hook('deleting', fail);
    await expect(deleteTheory(preview, db)).rejects.toThrow('injected delete failure');
    db.theory_documents.hook('deleting').unsubscribe(fail);
    expect((await loadTheory(first.document.id, db)).version.id).toBe(first.version.id);
    expect(await db.document_blocks.where('documentId').equals(first.document.id).count()).toBe(first.blocks.length);
  });
});
