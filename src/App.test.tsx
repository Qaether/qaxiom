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
});
