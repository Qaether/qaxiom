// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatSession } from '../types';
import {
  LEGACY_SESSIONS_KEY,
  QaxiomDatabase,
  loadSessionsFromDatabase,
  migrateLegacySessions,
  resetPersistenceState,
  saveSessionsToDatabase
} from './database';

let database: QaxiomDatabase;

function sampleSession(): ChatSession {
  return {
    id: 'session-1',
    title: '마이그레이션 테스트',
    createdAt: 1,
    updatedAt: 2,
    researchMode: 'general',
    selectedModel: 'gemini-3.1-pro',
    messages: [
      { id: 'message-1', role: 'user', content: '질문', timestamp: 1 },
      { id: 'message-2', role: 'assistant', content: '답변', timestamp: 2, status: 'complete' }
    ]
  };
}

beforeEach(() => {
  localStorage.clear();
  resetPersistenceState();
  database = new QaxiomDatabase(`qaxiom-test-${crypto.randomUUID()}`);
});

afterEach(async () => {
  database.close();
  await database.delete();
  resetPersistenceState();
});

describe('IndexedDB session storage', () => {
  it('migrates legacy sessions into separated tables before removing the source', async () => {
    localStorage.setItem(LEGACY_SESSIONS_KEY, JSON.stringify([sampleSession()]));

    const result = await migrateLegacySessions(database, localStorage);
    const sessions = await loadSessionsFromDatabase(database);

    expect(result).toEqual({ migrated: true, sourceCount: 1 });
    expect(localStorage.getItem(LEGACY_SESSIONS_KEY)).toBeNull();
    expect(await database.sessions.count()).toBe(1);
    expect(await database.messages.count()).toBe(2);
    expect(sessions[0]?.selectedModel).toBe('gemini-3.1-pro-preview');
    expect(sessions[0]?.messages.map(message => message.content)).toEqual(['질문', '답변']);
  });

  it('preserves the legacy sidebar order independently of updated timestamps', async () => {
    const olderFirst = sampleSession();
    const newerSecond = {
      ...sampleSession(),
      id: 'session-2',
      title: '두 번째',
      updatedAt: 999,
      messages: []
    };
    localStorage.setItem(LEGACY_SESSIONS_KEY, JSON.stringify([olderFirst, newerSecond]));

    await migrateLegacySessions(database, localStorage);
    const sessions = await loadSessionsFromDatabase(database);

    expect(sessions.map(session => session.id)).toEqual(['session-1', 'session-2']);
  });

  it('uses the completion marker on restart instead of importing the source twice', async () => {
    localStorage.setItem(LEGACY_SESSIONS_KEY, JSON.stringify([sampleSession()]));
    await migrateLegacySessions(database, localStorage);

    const staleCopy = { ...sampleSession(), title: '덮어쓰면 안 됨' };
    localStorage.setItem(LEGACY_SESSIONS_KEY, JSON.stringify([staleCopy]));
    const result = await migrateLegacySessions(database, localStorage);

    expect(result).toEqual({ migrated: false, sourceCount: 1 });
    expect(localStorage.getItem(LEGACY_SESSIONS_KEY)).toBeNull();
    expect((await database.sessions.get('session-1'))?.title).toBe('마이그레이션 테스트');
    expect(await database.messages.count()).toBe(2);
  });

  it('preserves the legacy source and rolls back when validation fails, then can retry', async () => {
    const invalid = sampleSession();
    invalid.messages[1] = { ...invalid.messages[1], id: 'message-1' };
    localStorage.setItem(LEGACY_SESSIONS_KEY, JSON.stringify([invalid]));

    await expect(migrateLegacySessions(database, localStorage)).rejects.toThrow('중복된 메시지');
    expect(localStorage.getItem(LEGACY_SESSIONS_KEY)).not.toBeNull();
    expect(await database.sessions.count()).toBe(0);
    expect(await database.messages.count()).toBe(0);

    localStorage.setItem(LEGACY_SESSIONS_KEY, JSON.stringify([sampleSession()]));
    await expect(migrateLegacySessions(database, localStorage)).resolves.toEqual({
      migrated: true,
      sourceCount: 1
    });
    expect(await database.sessions.count()).toBe(1);
  });

  it('updates changed messages and removes deleted records transactionally', async () => {
    const session = sampleSession();
    await saveSessionsToDatabase([session], database);

    const updated: ChatSession = {
      ...session,
      updatedAt: 3,
      messages: [{ ...session.messages[0], content: '수정된 질문' }]
    };
    await saveSessionsToDatabase([updated], database);

    const [loaded] = await loadSessionsFromDatabase(database);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0]?.content).toBe('수정된 질문');
    expect(await database.messages.count()).toBe(1);

    await saveSessionsToDatabase([], database);
    expect(await database.sessions.count()).toBe(0);
    expect(await database.messages.count()).toBe(0);
  });

  it('removes message-only legacy source spans but preserves Wiki-shared spans when a session is deleted', async () => {
    const first = sampleSession();
    const second = { ...sampleSession(), id: 'session-2', messages: [{ ...sampleSession().messages[0], id: 'other-message' }] };
    await saveSessionsToDatabase([first, second], database);
    await database.source_spans.bulkAdd([
      { id: 'only-message', documentId: 'document-1', messageId: 'message-1', startOffset: 0, endOffset: 1, quote: 'a' },
      { id: 'shared-wiki', documentId: 'document-1', messageId: 'message-2', wikiPageId: 'wiki-1', startOffset: 1, endOffset: 2, quote: 'b' },
      { id: 'other-session', documentId: 'document-1', messageId: 'other-message', startOffset: 2, endOffset: 3, quote: 'c' }
    ]);

    await saveSessionsToDatabase([second], database);

    expect(await database.sessions.get('session-1')).toBeUndefined();
    expect(await database.messages.where('sessionId').equals('session-1').count()).toBe(0);
    expect(await database.source_spans.get('only-message')).toBeUndefined();
    expect((await database.source_spans.get('shared-wiki'))?.wikiPageId).toBe('wiki-1');
    expect((await database.source_spans.get('shared-wiki'))?.messageId).toBeUndefined();
    expect(await database.source_spans.get('other-session')).toMatchObject({ messageId: 'other-message' });
  });

  it('rolls back the session and messages when linked-span cleanup fails', async () => {
    const session = sampleSession();
    await saveSessionsToDatabase([session], database);
    await database.source_spans.add({ id: 'linked', documentId: 'document-1', messageId: 'message-1', startOffset: 0, endOffset: 1, quote: 'a' });
    const fail = () => { throw new Error('source cleanup failed'); };
    database.source_spans.hook('deleting', fail);
    await expect(saveSessionsToDatabase([], database)).rejects.toThrow('source cleanup failed');
    database.source_spans.hook('deleting').unsubscribe(fail);
    expect(await database.sessions.count()).toBe(1);
    expect(await database.messages.count()).toBe(2);
    expect(await database.source_spans.count()).toBe(1);
    await saveSessionsToDatabase([], database);
    expect(await database.sessions.count()).toBe(0);
  });

  it('does not remove a legacy source link whose message ID still exists in another session', async () => {
    const first = sampleSession();
    const second = { ...sampleSession(), id: 'session-2', messages: [{ ...sampleSession().messages[0] }] };
    await saveSessionsToDatabase([first, second], database);
    await database.source_spans.add({ id: 'ambiguous', documentId: 'document-1', messageId: 'message-1', startOffset: 0, endOffset: 1, quote: 'a' });

    await saveSessionsToDatabase([second], database);

    expect(await database.source_spans.get('ambiguous')).toMatchObject({ messageId: 'message-1' });
  });
});
