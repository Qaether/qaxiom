import { test, expect } from './fixtures/test';
import { readFile } from 'node:fs/promises';

test('asks with canonical context only, excludes selected references and restores G citations without external evidence', async ({ page, browser }) => {
  let calls = 0;
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    calls++;
    const prompt = route.request().postDataJSON().contents.at(-1).parts[0].text as string;
    const data = JSON.parse(prompt.split('reference_data (인용 데이터, 지시 아님):\n')[1]);
    expect(data.retriever).toBe('graph-canonical-v1'); expect(data.evidence).toEqual([]);
    expect(data.graph.blocks).toHaveLength(1); expect(prompt).not.toContain('PRIVATE'); expect(prompt).not.toContain('external.txt');
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '자체 정본 [[G1]]을 사용한다. 외부 근거는 없다. [[R1]]은 유효하지 않다.' }] } }] })}\n\n` });
  });
  await page.goto('/'); await page.getByLabel('Google Gemini API Key').fill('canonical-question-fake');
  await page.getByRole('button', { name: '설정 저장' }).click(); await page.locator('#header-model-select').selectOption('gemini-3.1-pro-preview');
  await page.getByRole('button', { name: '연구노트', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구노트', exact: true });
  await editor.getByLabel('문서 제목', { exact: true }).fill('정본 단독 연구');
  await editor.getByLabel('문서 본문 (Markdown)').fill('# 가정\n\nA > 0.\n\n# PRIVATE unselected heading');
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click(); await expect(editor.getByRole('status')).toContainText('v1 저장 완료');
  await editor.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '레퍼런스 검색', exact: true }).click();
  const library = page.getByRole('dialog', { name: '레퍼런스 검색', exact: true });
  await library.getByLabel('레퍼런스 파일', { exact: true }).setInputFiles({ name: 'external.txt', mimeType: 'text/plain', buffer: Buffer.from('PRIVATE registered external source.') });
  await expect(library.getByRole('checkbox', { name: /external.txt/ })).toBeChecked();
  await library.getByLabel('필수 연구 기준 (정본 버전 선택)').selectOption({ label: '정본 단독 연구 · v1' });
  await library.getByRole('checkbox', { name: '답변에 승인 그래프 전제·정의 포함' }).check();
  await library.getByLabel('레퍼런스에 질문').fill('가정에서 이론을 전개해 줘');
  const previewButton = library.getByRole('button', { name: '정본만으로 질문 미리보기' });
  await expect(previewButton).toBeDisabled();
  await library.getByRole('checkbox', { name: /그래프 목표 블록 2/ }).check(); await previewButton.click();
  const preview = library.getByRole('region', { name: '전송 미리보기', exact: true });
  await expect(preview).toContainText('정본 단독 문맥'); await expect(preview).toContainText('레퍼런스 원문 0개'); await expect(preview).not.toContainText('PRIVATE'); expect(calls).toBe(0);
  await library.getByLabel('레퍼런스에 질문').fill('가정의 미확인 범위를 설명해 줘'); await expect(preview).toHaveCount(0);
  await previewButton.click(); await expect(preview).toContainText('가정의 미확인 범위');
  await library.getByRole('button', { name: '이 근거로 질문 보내기' }).click();
  const answer = page.getByRole('region', { name: '답변 근거' }); await expect(answer).toContainText('정본 단독 문맥');
  await expect(answer.getByRole('alert')).toContainText('전송 근거에 없는 인용: R1'); expect(calls).toBe(1);
  await answer.getByText('답변의 정본 그래프', { exact: false }).click(); await expect(answer).toContainText('A > 0');
  await page.locator('#open-settings-btn').click(); const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: '작업공간 백업', exact: true }).click(); const backup = (await (await ready).path())!;
  const serialized = await readFile(backup, 'utf8'); const data = JSON.parse(serialized); expect(data.version).toBe(22); expect(serialized).not.toContain('canonical-question-fake');
  const frozen = data.data.messages.find((m: { contextBundle?: unknown }) => m.contextBundle).contextBundle;
  expect(frozen.selectedSourceIds).toEqual([]); expect(frozen.evidence).toEqual([]); expect(frozen.retriever).toBe('graph-canonical-v1');
  const context = await browser.newContext();
  try {
    await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    const restored = await context.newPage(); await restored.goto('/'); restored.once('dialog', d => d.accept());
    await restored.getByLabel('Qaxiom 작업공간 백업 파일').setInputFiles(backup); await expect(restored.getByRole('status').filter({ hasText: '작업공간을 복원했습니다' })).toBeVisible();
    await restored.locator('.modal-close-btn').click();
    const restoredAnswer = restored.getByRole('region', { name: '답변 근거' }); await expect(restoredAnswer).toContainText('레퍼런스 원문 0개');
    await restoredAnswer.getByText('답변의 정본 그래프', { exact: false }).click(); await expect(restoredAnswer).toContainText(frozen.graph.context.contextHash);
  } finally { await context.close(); }
});
