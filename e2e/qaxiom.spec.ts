import { expect, test } from './fixtures/test';
import { readFile } from 'node:fs/promises';

const SETTINGS_KEY = 'qaxiom_user_settings_v1';
const SESSIONS_KEY = 'qaxiom_chat_sessions_v1';

test('uses keyboard controls for model, title, settings dialog and sending', async ({ page }) => {
  await page.addInitScript(key => {
    localStorage.setItem(key, JSON.stringify({ apiKeys: { gemini: 'e2e-key' }, defaultModel: 'gemini-3.8-flash' }));
  }, SETTINGS_KEY);
  await page.route('https://generativelanguage.googleapis.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '키보드 응답 완료' }] } }] })}\n\n`
  }));
  await page.goto('/');

  const model = page.getByRole('combobox', { name: '대화 모델 선택' });
  await model.focus();
  await expect(model).toBeFocused();
  await model.press('ArrowUp');
  await expect(model).toHaveValue('gemini-3.1-pro-preview');

  const titleButton = page.getByRole('button', { name: '새로운 연구 대화 제목 수정' });
  await titleButton.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: '대화 제목 입력' }).fill('키보드 연구');
  await page.getByRole('button', { name: '대화 제목 저장' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '키보드 연구' })).toBeVisible();
  await expect(page.getByRole('button', { name: '키보드 연구 제목 수정' })).toBeFocused();

  const settingsButton = page.locator('.header-right').getByRole('button', { name: '설정 (API 키)' });
  await settingsButton.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '연구 AI 환경 설정 (BYOK)' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '설정 닫기' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: '설정 저장' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '설정 닫기' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(settingsButton).toBeFocused();

  const input = page.getByRole('textbox', { name: '연구 질문 입력' });
  await input.fill('키보드 질문');
  await page.keyboard.press('Enter');
  await expect(page.getByText('키보드 응답 완료')).toBeVisible();
});

test('keyless onboarding persists a user-entered key across reloads', async ({ page }) => {
  await page.goto('/');

  const settingsDialog = page.getByRole('heading', { name: '연구 AI 환경 설정 (BYOK)' });
  await expect(settingsDialog).toBeVisible();
  await page.getByLabel('Google Gemini API Key').fill('e2e-user-key');
  await page.getByRole('button', { name: '설정 저장' }).click();

  await expect(settingsDialog).toBeHidden();
  await expect(page.getByText('AI API 키가 아직 등록되지 않았습니다.')).toHaveCount(0);

  await page.reload();
  await expect(settingsDialog).toHaveCount(0);
  const savedKey = await page.evaluate(key => {
    const settings = JSON.parse(localStorage.getItem(key) || '{}');
    return settings.apiKeys?.gemini;
  }, SETTINGS_KEY);
  expect(savedKey).toBe('e2e-user-key');
});

test('creates, exports, and restores a workspace without API keys', async ({ page, browser }) => {
  await page.addInitScript(({ settingsKey, sessionsKey }) => {
    localStorage.setItem(settingsKey, JSON.stringify({
      apiKeys: {
        gemini: 'e2e-key',
        openai: '',
        anthropic: '',
        customUrl: '',
        customKey: ''
      },
      defaultModel: 'gemini-3.8-flash',
      defaultMode: 'general',
      streamResponses: true,
      temperature: 0.7
    }));
    localStorage.setItem(sessionsKey, JSON.stringify([
      {
        id: 'session-first',
        title: '첫 연구',
        createdAt: 1,
        updatedAt: 2,
        researchMode: 'general',
        selectedModel: 'gemini-3.8-flash',
        messages: [
          { id: 'user-1', role: 'user', content: '검증할 질문', timestamp: 1 },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '검증된 답변',
            timestamp: 2,
            model: 'Gemini 3.8 Flash',
            status: 'complete'
          }
        ]
      },
      {
        id: 'session-second',
        title: '두 번째 연구',
        createdAt: 3,
        updatedAt: 4,
        researchMode: 'peer_review',
        selectedModel: 'gemini-3.8-flash',
        messages: []
      }
    ]));
  }, { settingsKey: SETTINGS_KEY, sessionsKey: SESSIONS_KEY });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '첫 연구' })).toBeVisible();
  await expect(page.getByText('검증된 답변')).toBeVisible();
  await expect.poll(async () => page.evaluate(key => localStorage.getItem(key), SESSIONS_KEY)).toBeNull();

  await page.getByRole('button', { name: '두 번째 연구 세션 선택' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '두 번째 연구' })).toBeVisible();
  await expect(page.getByRole('button', { name: '두 번째 연구 세션 선택' })).toHaveAttribute('aria-current', 'true');
  await page.getByRole('button', { name: '첫 연구 세션 선택' }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('heading', { name: '첫 연구' })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '내보내기' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('첫_연구.md');
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const markdown = await readFile(downloadPath!, 'utf8');
  expect(markdown).toContain('# 첫 연구');
  expect(markdown).toContain('검증할 질문');
  expect(markdown).toContain('검증된 답변');

  await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  const theory = page.getByRole('dialog', { name: '연구 문서', exact: true });
  await theory.getByRole('button', { name: '최근 답변으로 초안 만들기' }).click();
  await expect(theory.getByLabel('문서 본문 (Markdown)')).toHaveValue('검증된 답변');
  await theory.getByLabel('문서 제목', { exact: true }).fill('대화에서 만든 정본');
  await theory.getByRole('button', { name: '정본 문서 만들기' }).click();
  await expect(theory.getByRole('status')).toContainText('v1 저장 완료');
  await theory.getByRole('button', { name: '닫기', exact: true }).click();

  await page.getByRole('button', { name: '새 연구 세션' }).click();
  await expect(page.getByRole('heading', { name: '새로운 연구 대화' })).toBeVisible();
  await expect(page.getByText('대화 기록 (3)')).toBeVisible();

  await page.evaluate(() => {
    const state = window as unknown as { theoryExport?: { folder: string; files: Record<string, string> }; showDirectoryPicker?: () => Promise<unknown> };
    state.showDirectoryPicker = async () => ({
      async getDirectoryHandle(folder: string, options?: { create?: boolean }) {
        if (!options?.create) throw new DOMException('missing', 'NotFoundError');
        state.theoryExport = { folder, files: {} };
        return { async getFileHandle(name: string) {
          let content = '';
          return { async createWritable() { return {
            async write(value: string) { content = value; },
            async close() { state.theoryExport!.files[name] = content; },
            async abort() { content = ''; }
          }; } };
        } };
      },
      async getFileHandle() { throw new Error('not used'); },
      async removeEntry() { state.theoryExport = undefined; }
    });
  });
  await page.locator('#open-settings-btn').click();
  await page.getByRole('button', { name: '연구 문서 Markdown 저장' }).click();
  await expect(page.getByRole('status')).toContainText('현재 연구 문서 1개를 Markdown으로 저장했습니다');
  const theoryExport = await page.evaluate(() => (window as unknown as { theoryExport?: { folder: string; files: Record<string, string> } }).theoryExport);
  expect(theoryExport?.folder).toMatch(/^qaxiom-documents-/);
  const markdownFile = Object.keys(theoryExport!.files).find(name => name.endsWith('.md'))!;
  expect(theoryExport!.files[markdownFile]).toBe('검증된 답변');
  expect(JSON.parse(theoryExport!.files['manifest.json']).documents[0].file).toBe(markdownFile);
  const workspaceDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '작업공간 백업' }).click();
  const workspaceDownload = await workspaceDownloadPromise;
  const workspacePath = await workspaceDownload.path();
  expect(workspacePath).not.toBeNull();
  const workspaceJson = await readFile(workspacePath!, 'utf8');
  expect(workspaceJson).toContain('"format": "qaxiom-workspace"');
  expect(workspaceJson).not.toContain('e2e-key');

  const restoredContext = await browser.newContext();
  const restoredPage = await restoredContext.newPage();
  await restoredPage.goto('/');
  await expect(restoredPage.getByRole('heading', { name: '연구 AI 환경 설정 (BYOK)' })).toBeVisible();
  restoredPage.once('dialog', dialog => dialog.accept());
  await restoredPage.getByLabel('Qaxiom 작업공간 백업 파일').setInputFiles(workspacePath!);
  await expect(restoredPage.getByRole('status')).toContainText('세션 3개');
  await expect(restoredPage.getByLabel('Google Gemini API Key')).toHaveValue('');
  await restoredPage.locator('.modal-close-btn').click();
  await expect(restoredPage.getByText('대화 기록 (3)')).toBeVisible();
  await restoredPage.getByRole('button', { name: '첫 연구 세션 선택' }).click();
  await expect(restoredPage.getByText('검증된 답변')).toBeVisible();
  await restoredContext.close();
});

test('saves a fresh workspace backup to an explicitly selected browser folder', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as { savedWorkspace?: { name: string; json: string }; showDirectoryPicker?: () => Promise<unknown> };
    state.showDirectoryPicker = async () => ({
      async getFileHandle(name: string, options?: { create?: boolean }) {
        if (!options?.create) throw new DOMException('missing', 'NotFoundError');
        let json = '';
        return { async createWritable() { return {
          async write(value: string) { json = value; },
          async close() { state.savedWorkspace = { name, json }; },
          async abort() { json = ''; }
        }; } };
      }
    });
    localStorage.setItem('qaxiom_user_settings_v1', JSON.stringify({ apiKeys: { gemini: 'folder-test-secret' } }));
  });
  await page.goto('/');
  await page.locator('#open-settings-btn').click();
  await page.getByRole('button', { name: '폴더에 저장' }).click();
  await expect(page.getByRole('status')).toContainText('선택한 폴더에 qaxiom-workspace-');
  const saved = await page.evaluate(() => (window as unknown as { savedWorkspace?: { name: string; json: string } }).savedWorkspace);
  expect(saved?.name).toMatch(/^qaxiom-workspace-.*\.json$/);
  expect(JSON.parse(saved!.json).format).toBe('qaxiom-workspace');
  expect(saved!.json).not.toContain('folder-test-secret');
});

test('requires confirmation before deleting a session and keeps the deletion after reload', async ({ page }) => {
  await page.addInitScript(({ settingsKey, sessionsKey }) => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => ({ name: 'delete-test-folder' })
    });
    localStorage.setItem(settingsKey, JSON.stringify({ apiKeys: { gemini: 'e2e-key' } }));
    localStorage.setItem(sessionsKey, JSON.stringify(['첫 대화', '남길 대화'].map((title, index) => ({
      id: `delete-test-${index}`, title, createdAt: index + 1, updatedAt: index + 1,
      researchMode: 'general', selectedModel: 'gemini-3.8-flash', messages: [
        { id: `message-${index}`, role: 'user', content: title, timestamp: index + 1 }
      ]
    }))));
  }, { settingsKey: SETTINGS_KEY, sessionsKey: SESSIONS_KEY });
  await page.goto('/');
  await page.getByLabel('프로젝트 이름').fill('삭제 테스트');
  await page.getByRole('button', { name: '로컬 폴더 지정' }).click();
  await page.getByRole('button', { name: '채팅 화면 열기' }).click();
  await page.getByRole('button', { name: '대화 기록 보기' }).click();
  await expect(page.getByText('대화 기록 (2)')).toBeVisible();
  await page.getByRole('button', { name: '첫 대화 선택' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '첫 대화 세션 삭제' })).toBeFocused();
  await expect(page.getByRole('button', { name: '첫 대화 세션 삭제' })).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  const deleteDialog = page.getByRole('dialog', { name: '대화를 삭제할까요?' });
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog.getByText('연구 세션 “첫 대화”와 메시지 1개를 삭제합니다.')).toBeVisible();
  await expect(deleteDialog.getByRole('button', { name: '취소' })).toBeFocused();
  await deleteDialog.getByRole('button', { name: '취소' }).click();
  await expect(page.getByText('대화 기록 (2)')).toBeVisible();
  await expect(page.getByRole('button', { name: '첫 대화 세션 삭제' })).toBeFocused();
  await page.getByRole('button', { name: '첫 대화 세션 삭제' }).click();
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole('button', { name: '대화 삭제' }).click();
  await expect(page.getByText('대화 기록 (1)')).toBeVisible();
  await page.reload();
  await page.getByLabel('프로젝트 이름').fill('삭제 테스트');
  await page.getByRole('button', { name: '로컬 폴더 지정' }).click();
  await page.getByRole('button', { name: '채팅 화면 열기' }).click();
  await page.getByRole('button', { name: '대화 기록 보기' }).click();
  await expect(page.getByText('대화 기록 (1)')).toBeVisible();
  await expect(page.getByRole('button', { name: '첫 대화 세션 삭제' })).toHaveCount(0);
  await page.getByRole('button', { name: '남길 대화 세션 삭제' }).click();
  await page.getByRole('dialog', { name: '대화를 삭제할까요?' }).getByRole('button', { name: '대화 삭제' }).click();
  await expect(page.getByRole('heading', { name: '새로운 연구 대화' })).toBeVisible();
  await page.reload();
  await page.getByLabel('프로젝트 이름').fill('삭제 테스트');
  await page.getByRole('button', { name: '로컬 폴더 지정' }).click();
  await page.getByRole('button', { name: '채팅 화면 열기' }).click();
  await page.getByRole('button', { name: '대화 기록 보기' }).click();
  await expect(page.getByText('대화 기록 (1)')).toBeVisible();
  await expect(page.getByRole('button', { name: '남길 대화 세션 삭제' })).toHaveCount(0);
});
