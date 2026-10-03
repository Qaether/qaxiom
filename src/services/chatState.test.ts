import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types';
import {
  appendAssistantChunk,
  EMPTY_RESPONSE_MESSAGE,
  getRetryContext,
  settleAssistantMessage,
  STOPPED_RESPONSE_MESSAGE
} from './chatState';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    timestamp: 1,
    ...overrides
  };
}

describe('assistant message state policy', () => {
  it('appends chunks without losing partial output', () => {
    const first = appendAssistantChunk(message(), '첫');
    const second = appendAssistantChunk(first, ' 응답');

    expect(second).toMatchObject({
      content: '첫 응답',
      status: 'streaming',
      isStreaming: true
    });
  });

  it('marks a non-empty response as complete', () => {
    const result = settleAssistantMessage(message({ content: '완료' }), { type: 'finish' });

    expect(result).toMatchObject({ status: 'complete', isStreaming: false });
    expect(result.errorMessage).toBeUndefined();
  });

  it('turns an empty finish into a retryable error', () => {
    const result = settleAssistantMessage(message({ content: '   ' }), { type: 'finish' });

    expect(result).toMatchObject({
      status: 'error',
      errorMessage: EMPTY_RESPONSE_MESSAGE,
      isStreaming: false
    });
  });

  it('preserves partial output when stopped or failed', () => {
    const partial = message({ content: '보존할 부분 응답', status: 'streaming' });

    expect(settleAssistantMessage(partial, { type: 'stop' })).toMatchObject({
      content: '보존할 부분 응답',
      status: 'stopped',
      errorMessage: STOPPED_RESPONSE_MESSAGE
    });
    expect(settleAssistantMessage(partial, { type: 'error', message: 'network down' })).toMatchObject({
      content: '보존할 부분 응답',
      status: 'error',
      errorMessage: 'network down'
    });
  });
});

describe('retry policy', () => {
  const user = message({ id: 'user-1', role: 'user', content: '원래 질문' });

  it('reuses the preceding user message without duplicating it', () => {
    const failed = message({ status: 'error', errorMessage: 'failed' });
    const context = getRetryContext([user, failed], failed.id);

    expect(context).toEqual({ prompt: '원래 질문', history: [user] });
  });

  it('only retries the final stopped or failed assistant message', () => {
    const complete = message({ status: 'complete', content: '완료' });
    const failed = message({ status: 'error', errorMessage: 'failed' });
    const laterUser = message({ id: 'user-2', role: 'user', content: '후속 질문' });

    expect(getRetryContext([user, complete], complete.id)).toBeNull();
    expect(getRetryContext([user, failed, laterUser], failed.id)).toBeNull();
  });
});
