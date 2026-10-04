// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QaxiomDatabase } from './database';
import { captureDocumentContext, sessionsForDocument, verifyDocumentContext, withDocumentContext } from './documentChat';
import { createTheory } from './theory/documents';
import { EMPTY_CONTRACT } from './theory/types';
import type { ChatMessage, ChatSession } from '../types';

let db: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`document-chat-${crypto.randomUUID()}`); });
afterEach(async () => { await db.delete(); });

describe('document-scoped chat payload', () => {
  it('shows only the selected document history and keeps legacy history unlinked', () => {
    const base: Omit<ChatSession, 'id'> = { title: '대화', createdAt: 1, updatedAt: 1, messages: [], researchMode: 'general', selectedModel: 'gemini-3.8-flash' };
    const sessions = [
      { ...base, id: 'a', documentId: 'document-a' },
      { ...base, id: 'b', documentId: 'document-b' },
      { ...base, id: 'legacy' }
    ];
    expect(sessionsForDocument(sessions, 'document-a').map(session => session.id)).toEqual(['a']);
    expect(sessionsForDocument(sessions, 'document-b').map(session => session.id)).toEqual(['b']);
    expect(sessionsForDocument(sessions, null).map(session => session.id)).toEqual(['legacy']);
  });

  it('pins the saved revision and includes its entire body and contract in the provider request', async () => {
    const snapshot = await createTheory({ title: '기준', markdown: '# 전제\n\nA > 0\n\n## 결론\n\nB', contract: { ...EMPTY_CONTRACT, scope: '실수' } }, db);
    const context = await captureDocumentContext(snapshot.document.id, null, db);
    expect(context.versionId).toBe(snapshot.version.id);
    expect(context.contract.scope).toBe('실수');
    await verifyDocumentContext(context);
    const request = withDocumentContext([{ id: 'question', role: 'user', content: '검토해 줘', timestamp: 1 }], context);
    expect(request[0].content).toContain('A > 0');
    expect(request[0].content).toContain('## 결론');
    expect(request[0].content).toContain(context.contentHash);
    expect(request[0].content).toContain(snapshot.version.id);
  });

  it('pins an unsaved draft without pretending it is a saved version', async () => {
    const snapshot = await createTheory({ title: '기준', markdown: '저장된 내용', contract: { ...EMPTY_CONTRACT } }, db);
    const context = await captureDocumentContext(snapshot.document.id, {
      documentId: snapshot.document.id, versionId: snapshot.version.id, title: '수정 중',
      markdown: '아직 저장하지 않은 내용', contract: { ...EMPTY_CONTRACT }, dirty: true
    }, db);
    expect(context.versionId).toBeNull();
    expect(context.markdown).toBe('아직 저장하지 않은 내용');
    await verifyDocumentContext(context);
    await expect(verifyDocumentContext({ ...context, markdown: '변조' })).rejects.toThrow('hash');
  });

  it('rejects oversized requests rather than silently truncating research content', async () => {
    const snapshot = await createTheory({ title: '기준', markdown: 'A', contract: { ...EMPTY_CONTRACT } }, db);
    const context = await captureDocumentContext(snapshot.document.id, null, db);
    const question: ChatMessage = { id: 'question', role: 'user', content: 'Q'.repeat(512_000), timestamp: 1 };
    expect(() => withDocumentContext([question], context)).toThrow('512 KB');
  });
});
