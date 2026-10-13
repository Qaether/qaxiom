import { expect, test } from './fixtures/test';

test('shows analysis progress and provider summary, then renders math with source toggle', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true,
      value: async () => ({ name: 'research-folder' }) });
  });
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    const prompt = route.request().postDataJSON().contents[0].parts[0].text as string;
    const document = JSON.parse(prompt.slice(prompt.indexOf('research_document=') + 'research_document='.length));
    const result = {
      checkedBlockIds: document.blocks.map((block: { id: string }) => block.id),
      limitations: [],
      findings: [{
        blockId: document.blocks.at(-1).id,
        quote: '에너지 $E=mc^2$를 검토한다.',
        explanation: '에너지 $E=mc^2$의 정의를 확인해야 합니다.',
        resolution: '$E$와 $m$의 단위를 확인하세요.',
        replacement: '에너지 $E=mc^2$의 정의와 단위를 명시한다.'
      }]
    };
    await responseGate;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: [
      { candidates: [{ content: { parts: [{ text: '기호 정의를 검토 중입니다.', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] }
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') });
  });

  await page.goto('/');
  await page.getByLabel('프로젝트 이름').fill('분석 화면 확인');
  await page.getByRole('button', { name: '로컬 폴더 지정' }).click();
  await page.getByRole('button', { name: '채팅 화면 열기' }).click();
  await page.getByRole('button', { name: '키 설정하기 →' }).click();
  await page.getByLabel('Google Gemini API Key').fill('analysis-fake-key');
  await page.getByRole('button', { name: '설정 저장' }).click();

  await page.getByRole('button', { name: '새 연구노트' }).click();
  const editor = page.locator('dialog.theory-workspace');
  await editor.getByLabel('문서 제목', { exact: true }).fill('수식 검토');
  await editor.getByLabel('문서 본문 (Markdown)').fill('# 이론\n\n에너지 $E=mc^2$를 검토한다.');
  await editor.getByRole('button', { name: '문서 저장' }).click();
  await editor.getByRole('button', { name: 'AI로 문서 분석' }).click();
  await editor.locator('.theory-analysis-model-select').selectOption('gemini-3.1-pro-preview');
  await editor.getByRole('button', { name: '정합성 분석 시작' }).click();

  const analysis = editor.getByRole('region', { name: 'AI 분석 결과' });
  const progress = analysis.locator('.document-analysis-progress');
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute('open', '');
  await expect(progress).toContainText('모델 응답 대기 중');
  releaseResponse();

  await expect(analysis.getByRole('button', { name: '원문 보기' })).toBeVisible();
  await expect(progress).not.toHaveAttribute('open', '');
  await progress.locator('summary').click();
  await expect(progress).toContainText('기호 정의를 검토 중입니다.');
  await expect(analysis.locator('.analysis-finding-prose mjx-container.MathJax').first()).toBeVisible();
  await expect(analysis.getByText('수정안 수식 미리보기')).toBeVisible();
  await analysis.getByRole('button', { name: '원문 보기' }).click();
  await expect(analysis.getByText('에너지 $E=mc^2$의 정의를 확인해야 합니다.')).toBeVisible();
  await expect(analysis.getByText('수정안 수식 미리보기')).toHaveCount(0);
  await expect(analysis.getByLabel('원문과 수정안 비교')).toBeVisible();
});
