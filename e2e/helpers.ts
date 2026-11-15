import type { Page } from '@playwright/test';

export async function setupWorkspaceMocks(page: Page, apiKey = 'sk-test-openai-e2e-key-123456') {
  await page.addInitScript((injectedKey: string) => {
    const dirProto = {
      async queryPermission() {
        return 'granted';
      },
      async requestPermission() {
        return 'granted';
      }
    };

    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      writable: true,
      value: async () => Object.setPrototypeOf({ kind: 'directory', name: 'qaxiom-e2e-folder' }, dirProto)
    });

    if (!window.localStorage.getItem('qaxiom_user_settings_v1')) {
      window.localStorage.setItem(
        'qaxiom_user_settings_v1',
        JSON.stringify({
          apiKeys: {
            gemini: '',
            openai: injectedKey,
            anthropic: '',
            custom: ''
          },
          defaultModel: 'gpt-6-astra',
          defaultMode: 'general',
          streamResponses: true,
          temperature: 0.3
        })
      );
    }
  }, apiKey);
}

export async function openNewWorkspace(page: Page, projectName = 'E2E Physics Project') {
  await page.goto('/');
  await page.getByLabel('Project name').fill(projectName);
  await page.getByRole('button', { name: 'Choose local folder' }).click();
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await page.getByRole('textbox', { name: 'Enter research question' }).waitFor({ state: 'visible', timeout: 15_000 });
}

export async function createResearchNote(page: Page, title: string, body: string) {
  await page.getByRole('button', { name: 'Start New Document' }).click();
  await page.getByRole('textbox', { name: 'Document title' }).fill(title);
  await page.getByRole('textbox', { name: 'Document body (Markdown)' }).fill(body);
  await page.getByRole('button', { name: 'Save document', exact: true }).click();
  await page.getByRole('button', { name: 'Save new version' }).waitFor({ state: 'visible', timeout: 10_000 });
}

export async function mockOpenAIStream(page: Page, replyText: string) {
  await page.route('https://api.openai.com/v1/responses', async route => {
    const body = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: replyText })}\n\n`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } }
      })}\n\n`,
      'data: [DONE]\n\n'
    ].join('');
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body
    });
  });
}
