// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from './ChatInput';

afterEach(cleanup);

describe('ChatInput keyboard controls', () => {
  it('sends with Enter and keeps Shift+Enter as a newline', async () => {
    const user = userEvent.setup();
    const onSendMessage = vi.fn();
    render(<ChatInput onSendMessage={onSendMessage} isStreaming={false} onStopStreaming={vi.fn()} currentMode="general" />);

    const input = screen.getByRole('textbox', { name: '연구 질문 입력' });
    await user.type(input, '첫 줄{Shift>}{Enter}{/Shift}둘째 줄');
    expect((input as HTMLTextAreaElement).value).toBe('첫 줄\n둘째 줄');
    await user.keyboard('{Enter}');
    expect(onSendMessage).toHaveBeenCalledWith('첫 줄\n둘째 줄');
    expect((input as HTMLTextAreaElement).value).toBe('');
  });

  it('exposes and activates the stop button while streaming', async () => {
    const user = userEvent.setup();
    const onStopStreaming = vi.fn();
    const onSendMessage = vi.fn();
    render(<ChatInput onSendMessage={onSendMessage} isStreaming onStopStreaming={onStopStreaming} currentMode="general" />);

    expect(screen.getByRole('textbox', { name: '연구 질문 입력' }).hasAttribute('disabled')).toBe(true);
    const stop = screen.getByRole('button', { name: '생성 중단' });
    stop.focus();
    await user.keyboard('{Enter}');
    expect(onStopStreaming).toHaveBeenCalledOnce();
    expect(onSendMessage).not.toHaveBeenCalled();
  });
});
