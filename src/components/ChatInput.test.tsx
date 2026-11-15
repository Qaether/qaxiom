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

    const input = screen.getByRole('textbox', { name: 'Enter research question' });
    await user.type(input, 'First line{Shift>}{Enter}{/Shift}Second line');
    expect((input as HTMLTextAreaElement).value).toBe('First line\nSecond line');
    await user.keyboard('{Enter}');
    expect(onSendMessage).toHaveBeenCalledWith('First line\nSecond line');
    expect((input as HTMLTextAreaElement).value).toBe('');
  });

  it('exposes and activates the stop button while streaming', async () => {
    const user = userEvent.setup();
    const onStopStreaming = vi.fn();
    const onSendMessage = vi.fn();
    render(<ChatInput onSendMessage={onSendMessage} isStreaming onStopStreaming={onStopStreaming} currentMode="general" />);

    expect(screen.getByRole('textbox', { name: 'Enter research question' }).hasAttribute('disabled')).toBe(true);
    const stop = screen.getByRole('button', { name: 'Stop generation' });
    stop.focus();
    await user.keyboard('{Enter}');
    expect(onStopStreaming).toHaveBeenCalledOnce();
    expect(onSendMessage).not.toHaveBeenCalled();
  });
});
