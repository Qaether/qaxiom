// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageType } from '../types';
import { ChatMessage } from './ChatMessage';

afterEach(cleanup);

describe('ChatMessage status feedback', () => {
  it('keeps partial output visible and exposes an explicit retry action', async () => {
    const onRetry = vi.fn();
    const message: ChatMessageType = {
      id: 'assistant-1',
      role: 'assistant',
      content: '보존된 부분 응답',
      timestamp: 1,
      status: 'error',
      errorMessage: '네트워크 연결이 끊어졌습니다.'
    };

    render(<ChatMessage message={message} onRetry={onRetry} />);

    expect(screen.getByText('보존된 부분 응답')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('네트워크 연결이 끊어졌습니다.');
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('does not render retry when no retry callback is available', () => {
    render(<ChatMessage message={{
      id: 'assistant-2',
      role: 'assistant',
      content: '',
      timestamp: 1,
      status: 'stopped',
      errorMessage: '중단됨'
    }} />);

    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
  });
});
