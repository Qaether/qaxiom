import { expect, test } from './fixtures/test';

test('saves a document and starts AI analysis through the primary flow', async ({ page }) => {
  let calls = 0;
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    calls++;
    const prompt = route.request().postDataJSON().contents.at(-1).parts[0].text as string;
    const input = JSON.parse(prompt.split('원문이다:\n')[1]);
    const block = input.blocks.find((item: { quote: string }) => item.quote.includes('질량은 양수다.'));
    const result = {
      checkedBlockIds: input.blocks.map((item: { id: string }) => item.id), limitations: [],
      claims: [{ blockId: block.id, quote: '질량은 양수다.', kind: 'assumption' }], issues: []
    };
    await route.fulfill({
      status: 200, contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] })}\n\n`
    });
  });
  await page.goto('/');
  await page.getByLabel('Google Gemini API Key').fill('analysis-fake-key');
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.locator('#header-model-select').selectOption('gemini-3.1-pro-preview');
  await page.getByRole('button', { name: '연구노트', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구노트', exact: true });
  await editor.getByLabel('문서 제목', { exact: true }).fill('간단한 연구');
  await editor.getByLabel('문서 본문 (Markdown)').fill('# 가정\n\n질량은 양수다.');
  const saveBox = await editor.getByRole('button', { name: '정본 문서 만들기' }).boundingBox();
  const optionalCriteriaBox = await editor.locator('.theory-contract summary').boundingBox();
  expect(saveBox!.y).toBeLessThan(optionalCriteriaBox!.y);
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  const review = editor.getByRole('region', { name: '문서 검토', exact: true });
  await expect(review.getByRole('button', { name: '전송 내용 확인' })).toBeVisible();
  await expect(review.locator('.theory-review-advanced')).not.toHaveAttribute('open', '');
  await review.getByRole('button', { name: '전송 내용 확인' }).click();
  const preview = review.getByRole('region', { name: '검토 전송 미리보기' });
  await expect(preview).toContainText('질량은 양수다.');
  expect(calls).toBe(0);
  await preview.getByRole('button', { name: '이 범위로 LLM 검토 실행' }).click();
  await expect(review.getByRole('article').first()).toContainText('AI 내용·논리 검토');
  await expect(review.getByRole('article').first().getByRole('combobox', { name: /^주장 채택 상태/ })).toBeVisible();
  await expect(review.getByRole('article').first()).toContainText('질량은 양수다.');
  expect(calls).toBe(1);
});

test('plans a long document into explicitly confirmed AI analysis segments', async ({ page }) => {
  const checked: string[] = [];
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    const prompt = route.request().postDataJSON().contents.at(-1).parts[0].text as string;
    const data = JSON.parse(prompt.split('원문이다:\n')[1]);
    expect(data.blocks).toHaveLength(1);
    checked.push(data.blocks[0].id);
    const result = { checkedBlockIds: [data.blocks[0].id], limitations: [], claims: [], issues: [] };
    await route.fulfill({
      status: 200, contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] })}\n\n`
    });
  });
  await page.goto('/');
  await page.getByLabel('Google Gemini API Key').fill('analysis-fake-key');
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.locator('#header-model-select').selectOption('gemini-3.1-pro-preview');
  await page.getByRole('button', { name: '연구노트', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구노트', exact: true });
  await editor.getByLabel('문서 제목', { exact: true }).fill('긴 연구');
  await editor.getByLabel('문서 본문 (Markdown)').fill(['가'.repeat(8000), '나'.repeat(8000), '다'.repeat(8000)].join('\n\n'));
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  const review = editor.getByRole('region', { name: '문서 검토', exact: true });
  await review.getByRole('button', { name: '전송 내용 확인' }).click();
  const preview = review.getByRole('region', { name: '검토 전송 미리보기' });
  await expect(preview).toContainText('전체 3구간 중 이번 구간');
  await expect(preview).toContainText('문서 문단 1/3개');
  expect(checked).toHaveLength(0);
  await preview.getByRole('button', { name: '이 범위로 LLM 검토 실행' }).click();
  await expect(review).toContainText('전체 3구간 · 남은 2구간');
  await review.getByRole('button', { name: '전송 내용 확인' }).click();
  await expect(preview).toContainText('문서 문단 1/3개');
  expect(checked).toHaveLength(1);
  await preview.getByRole('button', { name: '이 범위로 LLM 검토 실행' }).click();
  await expect(review).toContainText('전체 3구간 · 남은 1구간');
  expect(checked).toHaveLength(2);
  expect(checked[0]).not.toBe(checked[1]);
});

test('confirms and deletes a reviewed research document without leaving its versions in the workspace', async ({ page }) => {
  await page.goto('/'); await page.locator('.modal-close-btn').click();
  await page.getByRole('button', { name: '연구노트', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구노트', exact: true });
  await editor.getByLabel('문서 제목', { exact: true }).fill('삭제할 실험 문서');
  await editor.getByLabel('문서 본문 (Markdown)').fill('# 가정\n\nA > 0');
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  await editor.locator('.theory-review-advanced > summary').click();
  await editor.getByRole('region', { name: '문서 검토' }).getByRole('button', { name: '기본 구조 확인' }).click();
  await editor.getByLabel('문서 본문 (Markdown)').fill('# 가정\n\nA > 1');
  await editor.getByRole('button', { name: '새 버전 저장' }).click();
  const firstDialog = page.waitForEvent('dialog');
  const firstClick = editor.getByRole('button', { name: '문서 삭제' }).click();
  const cancel = await firstDialog;
  expect(cancel.message()).toContain('문서 버전 2개'); expect(cancel.message()).toContain('검토 기록 1개');
  await cancel.dismiss(); await firstClick;
  await expect(editor.getByRole('button', { name: '삭제할 실험 문서 · v2' })).toBeVisible();
  const secondDialog = page.waitForEvent('dialog');
  const secondClick = editor.getByRole('button', { name: '문서 삭제' }).click();
  await (await secondDialog).accept(); await secondClick;
  await expect(editor.getByRole('status')).toContainText('문서를 삭제했습니다');
  await expect(editor.getByRole('button', { name: '삭제할 실험 문서 · v2' })).toHaveCount(0);
  await editor.getByRole('button', { name: '닫기', exact: true }).click();
  await page.reload(); await page.locator('.modal-close-btn').click(); await page.getByRole('button', { name: '연구노트', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '연구노트' })).toContainText('저장된 문서가 없습니다.');
});

test('suggests grounded research criteria after explicit preview and saves only checked fields', async ({ page }) => {
  let calls = 0;
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    calls++;
    const prompt = route.request().postDataJSON().contents.at(-1).parts[0].text as string;
    expect(prompt).toContain('질량은 양수다.');
    expect(prompt).toContain('중력 모형');
    const answer = JSON.stringify({
      criteria: {
        purpose: { text: '중력 모형을 연구한다.', quote: '중력 모형' },
        assumptions: { text: '질량이 양수라고 가정한다.', quote: '질량은 양수다.' },
        scope: { text: '모든 좌표계에 적용한다.', quote: '원문에 없는 범위' }
      }
    });
    await route.fulfill({
      status: 200, contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] } }] })}\n\n`
    });
  });
  await page.goto('/');
  await page.getByLabel('Google Gemini API Key').fill('criteria-fake-key');
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.locator('#header-model-select').selectOption('gemini-3.1-pro-preview');
  await page.getByRole('button', { name: '연구노트', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구노트', exact: true });
  const assistant = editor.getByRole('region', { name: 'AI 연구 기준 제안' });
  await expect(assistant.getByRole('button', { name: 'AI로 연구 기준 찾기' })).toBeVisible();
  await expect(assistant.getByRole('button', { name: 'AI로 연구 기준 찾기' })).toBeDisabled();
  const triggerBox = await assistant.getByRole('button', { name: 'AI로 연구 기준 찾기' }).boundingBox();
  const criteriaBox = await editor.locator('.theory-contract summary').boundingBox();
  expect(Math.abs(triggerBox!.y - criteriaBox!.y)).toBeLessThan(12);
  expect(triggerBox!.x).toBeGreaterThan(criteriaBox!.x);
  await editor.getByLabel('문서 제목', { exact: true }).fill('중력 모형');
  await editor.getByLabel('문서 본문 (Markdown)').fill('# 가정\n\n질량은 양수다.');
  await assistant.getByRole('button', { name: 'AI로 연구 기준 찾기' }).click();
  await expect(editor.locator('.theory-contract')).toHaveAttribute('open', '');
  await expect(editor.getByLabel('가정·공리', { exact: true })).toBeVisible();
  await expect(assistant.getByRole('region', { name: '연구 기준 AI 전송 확인' })).toContainText('질량은 양수다.');
  expect(calls).toBe(0);
  await editor.getByLabel('문서 본문 (Markdown)').fill('# 가정\n\n질량은 양수다.\n\n수정했다.');
  await expect(assistant.getByRole('button', { name: '이 문서로 AI 제안 받기' })).toHaveCount(0);
  await assistant.getByRole('button', { name: 'AI로 연구 기준 찾기' }).click();
  await assistant.getByRole('button', { name: '이 문서로 AI 제안 받기' }).click();
  const result = assistant.getByRole('region', { name: '연구 기준 AI 제안 결과' });
  await expect(result).toContainText('확인할 후보 2개');
  await expect(result).not.toContainText('모든 좌표계');
  await result.getByRole('checkbox', { name: /가정·공리/ }).check();
  await result.getByRole('button', { name: '선택한 연구 기준 반영' }).click();
  await expect(editor.locator('.theory-contract')).toHaveAttribute('open', '');
  await expect(editor.getByLabel('가정·공리', { exact: true })).toHaveValue('질량이 양수라고 가정한다.');
  await expect(editor.getByLabel('연구 목적', { exact: true })).toHaveValue('');
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  await expect(editor.getByRole('status')).toContainText('v1 저장 완료');
  await editor.getByRole('button', { name: '닫기', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '연구노트', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: '연구노트', exact: true });
  await reopened.getByRole('button', { name: '중력 모형 · v1' }).click();
  await reopened.locator('.theory-contract summary').click();
  await expect(reopened.getByLabel('가정·공리', { exact: true })).toHaveValue('질량이 양수라고 가정한다.');
  expect(calls).toBe(1);
});

test('reviews every part of a long document before suggesting criteria', async ({ page }) => {
  const prompts: string[] = [];
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    const prompt = route.request().postDataJSON().contents.at(-1).parts[0].text as string;
    prompts.push(prompt);
    const answer = JSON.stringify({
      criteria: prompt.includes('적용 범위는 마지막 장이다.')
        ? { scope: { text: '마지막 장에 적용한다.', quote: '적용 범위는 마지막 장이다.' } }
        : { assumptions: { text: '질량이 양수다.', quote: '질량은 양수다.' } }
    });
    await route.fulfill({
      status: 200, contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] } }] })}\n\n`
    });
  });
  await page.goto('/');
  await page.getByLabel('Google Gemini API Key').fill('criteria-fake-key');
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.locator('#header-model-select').selectOption('gemini-3.1-pro-preview');
  await page.getByRole('button', { name: '연구노트', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구노트', exact: true });
  const assistant = editor.getByRole('region', { name: 'AI 연구 기준 제안' });
  await editor.getByLabel('문서 제목', { exact: true }).fill('긴 중력 모형');
  await editor.getByLabel('문서 본문 (Markdown)').fill(`질량은 양수다.\n${'중간 전개를 기록한다.\n'.repeat(4000)}적용 범위는 마지막 장이다.`);
  await assistant.getByRole('button', { name: 'AI로 연구 기준 찾기' }).click();
  const preview = assistant.getByRole('region', { name: '연구 기준 AI 전송 확인' });
  const segmentCount = Number((await preview.locator('p').first().textContent())?.match(/(\d+)개 구간/)?.[1]);
  expect(segmentCount).toBeGreaterThan(1);
  await expect(preview).toContainText('제외되는 본문 구간은 없습니다.');
  expect(prompts).toHaveLength(0);
  await preview.getByRole('button', { name: '이 문서로 AI 제안 받기' }).click();
  await expect(assistant.getByRole('region', { name: '연구 기준 AI 제안 결과' })).toContainText('확인할 후보 2개');
  expect(prompts).toHaveLength(segmentCount);
  expect(prompts[0]).toContain('질량은 양수다.');
  expect(prompts.at(-1)).toContain('적용 범위는 마지막 장이다.');
});

test('links a declared research criterion to an immutable canonical block and retains it after reload', async ({ page }) => {
  await page.goto('/');
  await page.locator('.modal-close-btn').click();
  await page.getByRole('button', { name: '연구노트', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구노트', exact: true });
  await editor.getByLabel('문서 제목', { exact: true }).fill('근거 연결');
  await editor.getByLabel('문서 본문 (Markdown)').fill('# 가정\n\nx > 0.\n\n# 결과\n\ny > x.');
  await editor.locator('.theory-contract summary').click();
  await editor.getByLabel('가정·공리', { exact: true }).fill('x > 0');
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  await expect(editor.getByRole('status')).toContainText('v1 저장 완료');
  await editor.locator('.theory-review-advanced > summary').click();
  await expect(editor.getByRole('button', { name: '기본 구조 확인', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: '프로젝트 자료·문서 관리' })).toHaveCount(0);
  await expect(editor.locator('details[aria-label="고급 문서 도구"]')).not.toHaveAttribute('open');
  const anchor = editor.getByRole('combobox', { name: '근거 블록: 가정·공리' });
  await anchor.selectOption({ index: 2 });
  await editor.getByRole('button', { name: '새 버전 저장' }).click();
  await expect(editor.getByRole('status')).toContainText('v2 저장 완료');
  await expect(anchor).not.toHaveValue('');
  const blockId = await anchor.inputValue();
  await editor.getByRole('button', { name: '닫기', exact: true }).click();
  await page.reload();
  await page.locator('.modal-close-btn').click();
  await page.getByRole('button', { name: '연구노트', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: '연구노트', exact: true });
  await reopened.getByRole('button', { name: '근거 연결 · v2' }).click();
  await reopened.locator('.theory-contract summary').click();
  await expect(reopened.getByRole('combobox', { name: '근거 블록: 가정·공리' })).toHaveValue(blockId);
  await reopened.getByLabel('문서 본문 (Markdown)').fill('# 가정\n\nx > 1.\n\n# 결과\n\ny > x.');
  await reopened.getByRole('button', { name: '새 버전 저장' }).click();
  await expect(reopened.getByRole('status')).toContainText('v3 저장 완료');
  await expect(reopened.getByRole('combobox', { name: '근거 블록: 가정·공리' })).toHaveValue('');
});

test('versions a theory, compares and restores it, and transfers its history to a fresh profile', async ({ page, browser }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '연구 AI 환경 설정 (BYOK)' })).toBeVisible();
  await page.locator('.modal-close-btn').click();
  await page.getByRole('button', { name: '연구노트', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구노트', exact: true });
  await expect(editor).toBeVisible();
  await editor.getByLabel('문서 제목', { exact: true }).fill('조건부 이론');
  const first = '# 가정\n\nA > 0\n\n# 결과\n\nA는 양수다.';
  const second = '# 가정\n\nA > 1\n\n# 결과\n\nA는 양수다.';
  await editor.getByLabel('문서 본문 (Markdown)').fill(first);
  await editor.locator('.theory-contract summary').click();
  await editor.getByLabel('연구 목적', { exact: true }).fill('가정과 결론을 구분한다.');
  await editor.getByLabel('적용 범위', { exact: true }).fill('실수');
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  await expect(editor.getByRole('status')).toContainText('v1 저장 완료');

  await editor.getByLabel('문서 본문 (Markdown)').fill(second);
  await editor.getByRole('button', { name: '새 버전 저장' }).click();
  await expect(editor.getByRole('status')).toContainText('v2 저장 완료');
  await editor.locator('details[aria-label="고급 문서 도구"] > summary').click();
  await editor.getByLabel('비교할 버전').selectOption({ label: 'v1 — 조건부 이론' });
  await expect(editor.getByText('본문 변경 1개', { exact: false })).toBeVisible();
  await expect(editor.locator('.theory-diff pre').first()).toContainText('A > 0');
  await expect(editor.locator('.theory-diff pre').last()).toContainText('A > 1');
  page.once('dialog', dialog => dialog.accept());
  await editor.getByRole('button', { name: '이 버전으로 복원' }).click();
  await expect(editor.getByRole('status')).toContainText('v3으로 복원 완료');
  await expect(editor.getByLabel('문서 본문 (Markdown)')).toHaveValue(first);

  await editor.getByLabel('문서 본문 (Markdown)').fill('저장하지 않은 변경');
  page.once('dialog', dialog => dialog.dismiss());
  await editor.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('문서 본문 (Markdown)')).toHaveValue('저장하지 않은 변경');
  await editor.getByLabel('문서 본문 (Markdown)').fill(first);
  await editor.getByRole('button', { name: '닫기', exact: true }).click();

  await page.locator('#open-settings-btn').click();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: '작업공간 백업', exact: true }).click();
  const file = await (await downloadReady).path();
  expect(file).toBeTruthy();

  const other = await browser.newContext();
  try {
    const restored = await other.newPage();
    await restored.goto('/');
    await expect(restored.getByRole('heading', { name: '연구 AI 환경 설정 (BYOK)' })).toBeVisible();
    restored.once('dialog', dialog => dialog.accept());
    await restored.getByLabel('Qaxiom 작업공간 백업 파일').setInputFiles(file!);
    await expect(restored.getByRole('status')).toContainText('작업공간을 복원했습니다');
    await restored.reload();
    await expect(restored.getByRole('heading', { name: '연구 AI 환경 설정 (BYOK)' })).toBeVisible();
    await restored.locator('.modal-close-btn').click();
    await restored.getByRole('button', { name: '연구노트', exact: true }).click();
    const restoredEditor = restored.getByRole('dialog', { name: '연구노트', exact: true });
    await restoredEditor.getByRole('button', { name: '조건부 이론 · v3' }).click();
    await expect(restoredEditor.getByLabel('문서 본문 (Markdown)')).toHaveValue(first);
    await restoredEditor.locator('.theory-contract summary').click();
    await expect(restoredEditor.getByLabel('적용 범위', { exact: true })).toHaveValue('실수');
    await restoredEditor.locator('details[aria-label="고급 문서 도구"] > summary').click();
    await restoredEditor.getByLabel('비교할 버전').selectOption({ label: 'v2 — 조건부 이론' });
    await expect(restoredEditor.getByText('본문 변경 1개', { exact: false })).toBeVisible();
    await expect(restoredEditor.locator('.theory-diff pre').first()).toContainText('A > 1');
  } finally { await other.close(); }
});
