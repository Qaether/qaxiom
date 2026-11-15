// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { QaxiomDatabase, appendSessionEvent, loadSessionsFromDatabase } from '../services/database';
import { createWorkspaceBundle, parseWorkspaceBundle, restoreWorkspaceBundle } from '../services/workspace';
import type { ChatMessage } from '../types';
import {
  CheckpointTracker,
  createSessionEvent,
  projectSessionRecovery,
  sanitizeEventPayload
} from './sessionEvents';

const dbs: QaxiomDatabase[] = [];

function createTestDb(name: string): QaxiomDatabase {
  const db = new QaxiomDatabase(name);
  dbs.push(db);
  return db;
}

describe('sessionEvents & Dexie v26 recovery', () => {
  afterEach(async () => {
    while (dbs.length) {
      await dbs.pop()!.delete();
    }
  });

  it('throttles checkpoints by 400ms or 512 chars', () => {
    const tracker = new CheckpointTracker(400, 512);
    expect(tracker.shouldFlush(10, 1000)).toBe(true);
    tracker.markFlushed(10, 1000);

    expect(tracker.shouldFlush(100, 1100)).toBe(false);
    expect(tracker.shouldFlush(522, 1100)).toBe(true); // +512 chars
    tracker.markFlushed(522, 1100);

    expect(tracker.shouldFlush(530, 1499)).toBe(false);
    expect(tracker.shouldFlush(530, 1500)).toBe(true); // +400 ms
  });

  it('strips sensitive keys and rawBytes from event payloads', () => {
    const clean = sanitizeEventPayload({
      modelId: 'gpt-6-astra',
      apiKey: 'sk-secret',
      nested: { token: 'abc', authorization: 'Bearer x', safe: 'ok' },
      rawBytes: new Uint8Array([1, 2, 3])
    });

    expect(clean).toEqual({
      modelId: 'gpt-6-astra',
      nested: { safe: 'ok' }
    });
  });

  it('projects interrupted, completed, cancelled, and failed turns from events', () => {
    const base: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'Hi', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'partial', status: 'streaming', timestamp: 2 },
      { id: 'a2', role: 'assistant', content: '', status: 'streaming', timestamp: 3 }
    ];

    const events = [
      createSessionEvent({
        sessionId: 's1',
        turnId: 't1',
        messageId: 'a1',
        seq: 1,
        type: 'turn_checkpoint',
        payload: { content: 'recovered checkpoint text' }
      }),
      createSessionEvent({
        sessionId: 's1',
        turnId: 't2',
        messageId: 'a2',
        seq: 1,
        type: 'turn_completed',
        payload: { content: 'final completed text' }
      })
    ];

    const projected = projectSessionRecovery(base, events);
    expect(projected[1]).toMatchObject({
      content: 'recovered checkpoint text',
      status: 'error',
      errorMessage: 'Session interrupted before completion (recovered from checkpoint).'
    });
    expect(projected[2]).toMatchObject({
      content: 'final completed text',
      status: 'complete'
    });
  });

  it('recovers interrupted streaming messages when loading sessions from database', async () => {
    const db = createTestDb(`test-v26-${Date.now()}`);
    await db.sessions.put({
      id: 's1',
      documentId: null,
      position: 0,
      title: 'Test',
      createdAt: 1,
      updatedAt: 2,
      researchMode: 'general',
      selectedModel: 'gpt-6-astra'
    });
    await db.messages.put({
      id: 'a1',
      sessionId: 's1',
      position: 0,
      role: 'assistant',
      content: '',
      status: 'streaming',
      timestamp: 2
    });
    await appendSessionEvent(
      createSessionEvent({
        sessionId: 's1',
        turnId: 'turn-a1',
        messageId: 'a1',
        seq: 1,
        type: 'turn_checkpoint',
        payload: { content: 'saved mid-stream' }
      }),
      db
    );

    const sessions = await loadSessionsFromDatabase(db);
    expect(sessions[0].messages[0].content).toBe('saved mid-stream');
    expect(sessions[0].messages[0].status).toBe('error');
  });

  it('exports and restores sessionEvents in v25 bundles while accepting v24 legacy bundles', async () => {
    const db = createTestDb(`test-backup-${Date.now()}`);
    await db.sessions.put({
      id: 's1',
      documentId: null,
      position: 0,
      title: 'Test',
      createdAt: 1,
      updatedAt: 2,
      researchMode: 'general',
      selectedModel: 'gpt-6-astra'
    });
    await db.messages.put({
      id: 'm1',
      sessionId: 's1',
      position: 0,
      role: 'user',
      content: 'Hello',
      timestamp: 1
    });
    await appendSessionEvent(
      createSessionEvent({
        sessionId: 's1',
        turnId: 't1',
        messageId: 'a1',
        seq: 1,
        type: 'turn_completed',
        payload: { content: 'Done', apiKey: 'should-be-stripped' }
      }),
      db
    );

    const bundle = await createWorkspaceBundle(db);
    expect(bundle.version).toBe(25);
    expect(bundle.data.sessionEvents).toHaveLength(1);
    expect(bundle.data.sessionEvents[0].payload).toEqual({ content: 'Done' });

    const legacyV24 = {
      ...bundle,
      version: 24,
      data: { ...bundle.data }
    };
    delete (legacyV24.data as Record<string, unknown>).sessionEvents;
    const parsedLegacy = parseWorkspaceBundle(legacyV24);
    expect(parsedLegacy.data.sessionEvents).toEqual([]);

    const target = createTestDb(`test-restore-${Date.now()}`);
    await restoreWorkspaceBundle(bundle, target);
    expect(await target.session_events.count()).toBe(1);
  });
});
