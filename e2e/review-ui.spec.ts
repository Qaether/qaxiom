import { expect, test } from './fixtures/test';

test('one click saves the whole document, shows anchored inline findings, and stages a diff', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true,
      value: async () => ({ name: 'research-folder' }) });
    localStorage.setItem('qaxiom_user_settings_v1', JSON.stringify({
      apiKeys: { gemini: 'e2e-key' }, defaultModel: 'gemini-3.8-flash'
    }));
  });
  let calls = 0;
  let sentMarkdown = '';
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    calls++;
    const prompt = route.request().postDataJSON().contents.at(-1).parts[0].text as string;
    const input = JSON.parse(prompt.split('research_document=')[1]);
    sentMarkdown = input.markdown;
    const block = input.blocks.find((item: { startOffset: number; endOffset: number }) =>
      input.markdown.slice(item.startOffset, item.endOffset).includes('질량은 양수다.'));
    const result = { checkedBlockIds: input.blocks.map((item: { id: string }) => item.id), limitations: [],
      findings: [{ blockId: block.id, quote: '질량은 양수다.', explanation: '측정 범위가 명시되지 않았습니다.',
        resolution: '범위를 명시하세요.', replacement: '관찰 범위에서 질량은 양수다.\n' }] };
    await route.fulfill({ status: 200, contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] })}\n\n` });
  });
  await page.goto('/');
  await page.getByLabel('프로젝트 이름').fill('검토 UX');
  await page.getByRole('button', { name: '로컬 폴더 지정' }).click();
  await page.getByRole('button', { name: '채팅 화면 열기' }).click();
  await page.getByRole('button', { name: '새 연구 문서' }).click();
  const editor = page.locator('dialog.theory-workspace');
  await editor.getByLabel('문서 제목', { exact: true }).fill('질량 가설');
  const longParagraph = '긴문서내용'.repeat(4000);
  await editor.getByLabel('문서 본문 (Markdown)').fill(`# 가정\n\n질량은 양수다.\n\n${longParagraph}`);
  await editor.getByRole('button', { name: 'AI로 문서 분석' }).click();
  const analysis = editor.getByRole('region', { name: 'AI 분석 결과' });
  await expect(analysis.getByText('측정 범위가 명시되지 않았습니다.', { exact: true })).toBeVisible();
  await expect(analysis).toContainText('==>');
  expect(calls).toBe(1);
  expect(sentMarkdown).toContain(longParagraph);
  expect(new TextEncoder().encode(sentMarkdown).byteLength).toBeGreaterThan(40000);
  await expect(editor.getByRole('button', { name: 'v1 버전 비교' })).toBeVisible();
  await analysis.getByRole('button', { name: '수정안 비교' }).click();
  await expect(analysis.getByLabel('원문과 수정안 비교')).toContainText('관찰 범위에서 질량은 양수다.');
  await analysis.getByRole('button', { name: '편집 내용에 적용' }).click();
  await expect(editor.getByLabel('문서 본문 (Markdown)')).toHaveValue(/관찰 범위에서 질량은 양수다/);
  await expect(editor.getByRole('button', { name: '새 버전 저장' })).toBeEnabled();
  await editor.getByRole('button', { name: '새 버전 저장' }).click();
  await expect(editor.getByRole('button', { name: 'v2 버전 비교' })).toBeVisible();
  await editor.getByRole('button', { name: '분석', exact: true }).click();
  await expect(editor.getByRole('region', { name: 'AI 분석 결과' })).toContainText('질량은 양수다.');
  await editor.getByRole('region', { name: 'AI 분석 결과' }).getByRole('button', { name: '수정안 비교' }).click();
  await expect(editor.getByRole('region', { name: 'AI 분석 결과' }).getByRole('button', { name: '편집 내용에 적용' })).toBeDisabled();
  expect(calls).toBe(1);
});
