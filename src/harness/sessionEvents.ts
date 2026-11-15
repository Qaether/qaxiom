import type { ChatMessage } from '../types';
import type { SessionEventRecord, SessionEventType } from '../services/database';

export const CHECKPOINT_INTERVAL_MS = 400;
export const CHECKPOINT_CHAR_THRESHOLD = 512;

const SENSITIVE_KEYS = new Set(['apikey', 'api_key', 'authorization', 'secret', 'token', 'rawbytes', 'bytes']);

export function sanitizeEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      clean[key] = sanitizeEventPayload(value as Record<string, unknown>);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

export function createSessionEvent(params: {
  sessionId: string;
  turnId: string;
  messageId: string;
  seq: number;
  type: SessionEventType;
  createdAt?: number;
  payload?: Record<string, unknown>;
}): SessionEventRecord {
  return {
    id: `${params.turnId}:${params.seq}`,
    sessionId: params.sessionId,
    turnId: params.turnId,
    messageId: params.messageId,
    seq: params.seq,
    type: params.type,
    createdAt: params.createdAt ?? Date.now(),
    payload: sanitizeEventPayload(params.payload ?? {})
  };
}

export class CheckpointTracker {
  private lastFlushedAt = 0;
  private lastFlushedLength = 0;
  private readonly intervalMs: number;
  private readonly charThreshold: number;

  constructor(
    intervalMs = CHECKPOINT_INTERVAL_MS,
    charThreshold = CHECKPOINT_CHAR_THRESHOLD
  ) {
    this.intervalMs = intervalMs;
    this.charThreshold = charThreshold;
  }

  shouldFlush(currentLength: number, now = Date.now()): boolean {
    if (currentLength <= this.lastFlushedLength) return false;
    const charsDelta = currentLength - this.lastFlushedLength;
    const timeDelta = now - this.lastFlushedAt;
    return charsDelta >= this.charThreshold || timeDelta >= this.intervalMs;
  }

  markFlushed(currentLength: number, now = Date.now()): void {
    this.lastFlushedLength = currentLength;
    this.lastFlushedAt = now;
  }
}

export function projectSessionRecovery(
  messages: ChatMessage[],
  events: SessionEventRecord[]
): ChatMessage[] {
  if (events.length === 0) return messages;

  const eventsByMessage = new Map<string, SessionEventRecord[]>();
  for (const event of events) {
    const list = eventsByMessage.get(event.messageId) ?? [];
    list.push(event);
    eventsByMessage.set(event.messageId, list);
  }

  return messages.map(message => {
    if (message.role !== 'assistant' || message.status !== 'streaming') {
      return message;
    }
    const msgEvents = (eventsByMessage.get(message.id) ?? []).slice().sort((a, b) => a.seq - b.seq);
    if (msgEvents.length === 0) return message;

    let latestContent = message.content;
    let settledStatus: ChatMessage['status'] | null = null;
    let errorMessage = message.errorMessage;

    for (const event of msgEvents) {
      if (typeof event.payload.content === 'string') {
        latestContent = event.payload.content;
      }
      if (event.type === 'turn_completed') {
        settledStatus = 'complete';
        errorMessage = undefined;
      } else if (event.type === 'turn_cancelled') {
        settledStatus = 'complete';
        errorMessage = undefined;
      } else if (event.type === 'turn_failed') {
        settledStatus = 'error';
        if (typeof event.payload.error === 'string' && event.payload.error) {
          errorMessage = event.payload.error;
        }
      }
    }

    if (settledStatus) {
      return {
        ...message,
        content: latestContent,
        status: settledStatus,
        errorMessage
      };
    }

    return {
      ...message,
      content: latestContent,
      status: 'error',
      errorMessage: errorMessage ?? 'Session interrupted before completion (recovered from checkpoint).'
    };
  });
}
