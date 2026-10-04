import { expect, test } from './fixtures/test';

test('routes small talk without the document and sends a long research document intact', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true,
      value: async () => ({ name: 'research-folder' }) });
    localStorage.setItem('qaxiom_user_settings_v1', JSON.stringify({
      apiKeys: { gemini: 'e2e-key' }, defaultModel: 'gemini-3.8-flash'
    }));
  });
  const calls: { url: string; body: string }[] = [];
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    const url = route.request().url();
    calls.push({ url, body: route.request().postData() ?? '' });
    if (url.includes(':generateContent')) {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'research' }] } }] }) });
    } else {
      await route.fulfill({ status: 200, contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '모의 답변' }] } }] })}\n\n` });
    }
  });
  await page.goto('/');
  await page.getByLabel('프로젝트 이름').fill('문서 대화');
  await page.getByRole('button', { name: '로컬 폴더 지정' }).click();
  await page.getByRole('button', { name: '채팅 화면 열기' }).click();
  await page.getByRole('button', { name: '새 연구 문서' }).click();
  const editor = page.locator('dialog.theory-workspace');
  const longDocument = `# 전제\n\n${'연구 문서 내용 '.repeat(5_000)}\n\n끝 문단`;
  await editor.getByLabel('문서 제목', { exact: true }).fill('긴 정본');
  await editor.getByLabel('문서 본문 (Markdown)').fill(longDocument);
  await editor.getByRole('button', { name: '문서 저장' }).click();
  await expect(editor).toContainText('v1 저장 완료');

  const input = page.getByRole('textbox', { name: '연구 질문 입력' });
  await input.fill('하이');
  await page.getByRole('button', { name: '메시지 전송' }).click();
  await expect(page.getByText('모의 답변')).toBeVisible();
  const firstAnswer = page.locator('.assistant-message-row').first();
  await expect(firstAnswer.locator('.assistant-avatar, .message-meta')).toHaveCount(0);
  await expect(firstAnswer.locator('.assistant-message-footer')).toBeVisible();
  await expect(firstAnswer.getByRole('button', { name: '답변 복사' })).toHaveText('');
  await expect(firstAnswer.locator('.markdown-content')).toHaveCSS('border-top-width', '0px');
  await expect(firstAnswer.locator('.markdown-content')).toHaveCSS('font-size', '12px');
  await expect(page.locator('.user-message-row').first().locator('.markdown-content')).toHaveCSS('font-size', '12px');
  await expect(input).toHaveCSS('font-size', '12px');
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toContain('gemini-3.5-flash-lite');
  expect(calls[0].body).not.toContain('연구 문서 내용');

  await input.fill('이 문서의 전제를 검토해 줘');
  await page.getByRole('button', { name: '메시지 전송' }).click();
  await expect.poll(() => calls.length).toBe(3);
  expect(calls[1].url).toContain('gemini-3.5-flash-lite:generateContent');
  expect(calls[1].body).not.toContain('연구 문서 내용');
  expect(calls[2].url).toContain('gemini-3.8-flash:streamGenerateContent');
  expect(calls[2].body).toContain('끝 문단');
  expect(calls[2].body).toContain('연구 문서 내용');

  await page.getByRole('button', { name: '새 연구 문서' }).click();
  await editor.getByLabel('문서 제목', { exact: true }).fill('두 번째 정본');
  await editor.getByLabel('문서 본문 (Markdown)').fill('# 다른 전제');
  await editor.getByRole('button', { name: '문서 저장' }).click();
  await page.getByRole('button', { name: '대화 기록 보기' }).click();
  await expect(page.getByText('대화 기록 (1)')).toBeVisible();
  await page.getByRole('button', { name: '대화 기록 닫기' }).click();
  await page.getByRole('button', { name: '긴 정본 v1' }).click();
  await page.getByRole('button', { name: '대화 기록 보기' }).click();
  await expect(page.getByText('대화 기록 (1)')).toBeVisible();
  await expect(page.getByRole('button', { name: '하이 선택' })).toBeVisible();
  await page.getByRole('button', { name: '대화 기록 닫기' }).click();
  await page.getByRole('button', { name: '긴 정본 문서 삭제' }).click();
  const deleteDialog = page.getByRole('dialog', { name: '연구 문서를 삭제할까요?' });
  await expect(deleteDialog.getByRole('alert')).toContainText('대화가 남아 있습니다');
  await expect(deleteDialog.getByRole('button', { name: '문서 삭제' })).toBeDisabled();
  await deleteDialog.getByRole('button', { name: '취소' }).click();
  await expect(page.getByRole('button', { name: '긴 정본 v1' })).toBeVisible();
});
