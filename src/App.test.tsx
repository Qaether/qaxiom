// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { qaxiomDatabase } from './services/database';

beforeEach(async () => {
  localStorage.clear();
  await qaxiomDatabase.project_folders.clear();
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: vi.fn(async () => ({ name: 'test-folder' })) });
});

afterEach(cleanup);

describe('onboarding flow', () => {
  async function enterProject(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText('Project name'), 'Test Project');
    await user.click(screen.getByRole('button', { name: 'Choose local folder' }));
    await screen.findByText('Selected folder: test-folder');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Open workspace' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Open workspace' }));
  }

  it('shows chat after project selection and saves a user-provided key from settings', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
    await enterProject(user);
    expect(await screen.findByRole('heading', { name: 'Qaxiom Research Intelligence' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Settings (Local CLI)' }));
    expect(await screen.findByRole('heading', { name: 'Qaxiom Desktop Settings' })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Default Reasoning Model'), 'claude-cli');
    await user.click(screen.getByRole('button', { name: 'Save Settings' }));

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('qaxiom_user_settings_v1') || '{}');
      expect(saved.defaultModel).toBe('claude-cli');
    });
  });

  it('shows an IndexedDB initialization warning without blocking the app', async () => {
    const user = userEvent.setup();
    render(<App initialStorageWarning="Existing chat data was preserved." />);

    await enterProject(user);
    expect((await screen.findByRole('alert')).textContent).toContain('Existing chat data was preserved.');
    expect(await screen.findByRole('heading', { name: 'Qaxiom Research Intelligence' })).toBeTruthy();
  });

  it('exposes hover labels on the left and center pane top-bar buttons', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);

    await enterProject(user);

    await waitFor(() => {
      expect(container.querySelector('.sidebar-brand-btn')?.getAttribute('data-tooltip')).toBe('Manage projects');
    });
    expect(container.querySelector('.center-header-new-btn')?.getAttribute('data-tooltip')).toBe('New document');
    expect(container.querySelector('.chat-history-toggle-btn')?.getAttribute('data-tooltip')).toBe('Chat history');
    expect(container.querySelector('.chat-title-toggle-btn')?.getAttribute('data-tooltip')).toBe('Rename');
    expect(container.querySelector('.chat-panel-header-left')?.firstElementChild?.classList.contains('chat-panel-mode-wrapper')).toBe(true);
    expect(container.querySelector('.chat-panel-header-right')?.firstElementChild?.classList.contains('chat-title-toggle-btn')).toBe(true);
    expect(container.querySelector('.center-document-header .header-project-label')?.tagName).toBe('DIV');
    expect(container.querySelector('.chat-title-toggle-btn span')).toBeNull();
    expect(container.textContent).not.toContain('LLM Research Wiki');

    await user.click(screen.getByRole('button', { name: /^Rename / }));
    expect(await screen.findByRole('textbox', { name: 'Enter chat title' })).toBeTruthy();
  });

  it('renames and deletes a project from the Projects list', async () => {
    const user = userEvent.setup();
    render(<App />);

    await enterProject(user);
    await user.click(await screen.findByRole('button', { name: 'Go to project management / switcher' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Rename Test Project' }));
    const renameInput = screen.getByRole('textbox', { name: 'New project name for Test Project' });
    await user.clear(renameInput);
    await user.type(renameInput, 'Renamed Project');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Renamed Project')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Delete Renamed Project' }));
    expect(screen.getByText('Remove from list? (Local folder files will not be deleted)')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));

    await waitFor(() => {
      expect(screen.queryByText('Renamed Project')).toBeNull();
    });
  });
});
