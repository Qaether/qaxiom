// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageType } from '../types';
import { ChatMessage } from './ChatMessage';

afterEach(cleanup);

describe('ChatMessage status feedback', () => {
  it('shows an unframed assistant answer without avatar or model badges and places icon-only copy last', () => {
    const { container } = render(<ChatMessage message={{
      id: 'assistant-simple', role: 'assistant', content: 'Research answer', timestamp: 1,
      model: 'Gemini 3.8 Flash', researchMode: 'general', status: 'complete'
    }} />);

    expect(container.querySelector('.assistant-avatar')).toBeNull();
    expect(container.querySelector('.message-meta')).toBeNull();
    expect(container.textContent).not.toContain('Gemini 3.8 Flash');
    expect(container.textContent).not.toContain('General');
    const body = container.querySelector('.message-body');
    expect(body?.lastElementChild?.classList.contains('assistant-message-footer')).toBe(true);
    expect(screen.getByRole('button', { name: 'Copy response' }).textContent).toBe('');
    expect(container.querySelector('.markdown-content')?.textContent).toContain('Research answer');
  });

  it('keeps partial output visible and exposes an explicit retry action', async () => {
    const onRetry = vi.fn();
    const message: ChatMessageType = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Preserved partial response',
      timestamp: 1,
      status: 'error',
      errorMessage: 'Network connection lost.'
    };

    render(<ChatMessage message={message} onRetry={onRetry} />);

    expect(screen.getByText('Preserved partial response')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Network connection lost.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('does not render retry when no retry callback is available', () => {
    render(<ChatMessage message={{
      id: 'assistant-2',
      role: 'assistant',
      content: '',
      timestamp: 1,
      status: 'stopped',
      errorMessage: 'Stopped'
    }} />);

    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('renders apply button in footer and triggers append callback before replace callbacks', async () => {
    const onApply = vi.fn();
    const onDirectAccept = vi.fn();
    const onAppend = vi.fn();
    render(<ChatMessage
      message={{
        id: 'assistant-apply-footer',
        role: 'assistant',
        content: 'Content to append',
        timestamp: 1,
        status: 'complete'
      }}
      onApplyToDocument={onApply}
      onDirectAcceptDocument={onDirectAccept}
      onAppendToDocument={onAppend}
    />);

    const footerApplyBtn = screen.getByRole('button', { name: 'Apply to research note' });
    await userEvent.click(footerApplyBtn);
    expect(onAppend).toHaveBeenCalledWith('Content to append');
    expect(onDirectAccept).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('renders apply button in code block header and triggers callback with code string when clicked', async () => {
    const onApply = vi.fn();
    render(<ChatMessage
      message={{
        id: 'assistant-apply-code',
        role: 'assistant',
        content: '```markdown\n# Revised Theory\n```\nExplanation text',
        timestamp: 1,
        status: 'complete'
      }}
      onApplyToDocument={onApply}
    />);

    const codeApplyBtn = screen.getByRole('button', { name: 'Apply to note' });
    await userEvent.click(codeApplyBtn);
    expect(onApply).toHaveBeenCalledWith('# Revised Theory');
  });

  it('renders GFM markdown tables with table elements and preserves LaTeX rendering', () => {
    const { container } = render(<ChatMessage
      message={{
        id: 'assistant-table',
        role: 'assistant',
        content: '| Item | Value |\n| --- | --- |\n| Norm | $|x|$ |\n\nInline \\(a^2 + b^2 = c^2\\) and block:\n\\[E = mc^2\\]',
        timestamp: 1,
        status: 'complete'
      }}
    />);

    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Item' })).toBeTruthy();
    expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(3);
  });
});
