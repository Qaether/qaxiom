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
    await user.type(await screen.findByLabelText('프로젝트 이름'), '테스트 프로젝트');
    await user.click(screen.getByRole('button', { name: '로컬 폴더 지정' }));
    await screen.findByText('선택한 폴더: test-folder');
    await waitFor(() => expect((screen.getByRole('button', { name: '채팅 화면 열기' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: '채팅 화면 열기' }));
  }

  it('shows chat after project selection and saves a user-provided key from settings', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
    await enterProject(user);
    expect(await screen.findByRole('heading', { name: 'Qaxiom Research Intelligence' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '키 설정하기 →' }));
    expect(await screen.findByRole('heading', { name: '연구 AI 환경 설정 (BYOK)' })).toBeTruthy();
    await user.type(screen.getByLabelText('Google Gemini API Key'), 'user-entered-key');
    await user.click(screen.getByRole('button', { name: '설정 저장' }));

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('qaxiom_user_settings_v1') || '{}');
      expect(saved.apiKeys?.gemini).toBe('user-entered-key');
    });
  });

  it('shows an IndexedDB initialization warning without blocking the app', async () => {
    const user = userEvent.setup();
    render(<App initialStorageWarning="기존 대화 데이터는 보존했습니다." />);

    await enterProject(user);
    expect((await screen.findByRole('alert')).textContent).toContain('기존 대화 데이터는 보존했습니다.');
    expect(await screen.findByRole('heading', { name: 'Qaxiom Research Intelligence' })).toBeTruthy();
  });

  it('exposes hover labels on the left and center pane top-bar buttons', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);

    await enterProject(user);

    await waitFor(() => {
      expect(container.querySelector('.sidebar-brand-btn')?.getAttribute('data-tooltip')).toBe('프로젝트 관리');
    });
    expect(container.querySelector('.center-header-new-btn')?.getAttribute('data-tooltip')).toBe('새 문서');
    expect(container.querySelector('.chat-history-toggle-btn')?.getAttribute('data-tooltip')).toBe('대화 기록');
    expect(container.querySelector('.chat-title-toggle-btn')?.getAttribute('data-tooltip')).toBe('제목 변경');
    expect(container.querySelector('.chat-panel-header-left')?.firstElementChild?.classList.contains('chat-panel-mode-wrapper')).toBe(true);
    expect(container.querySelector('.chat-panel-header-right')?.firstElementChild?.classList.contains('chat-title-toggle-btn')).toBe(true);
    expect(container.querySelector('.center-document-header .header-project-label')?.tagName).toBe('DIV');
    expect(container.querySelector('.chat-title-toggle-btn span')).toBeNull();
    expect(container.textContent).not.toContain('LLM Research Wiki');

    await user.click(screen.getByRole('button', { name: '새로운 연구 대화 제목 수정' }));
    expect(await screen.findByRole('textbox', { name: '대화 제목 입력' })).toBeTruthy();
  });
});
