import { test, expect } from './fixtures/test';
import { readFile } from 'node:fs/promises';

test('reviews grounded issues, approves a patch, rechecks its new version and restores review history', async ({ page, browser }) => {
  let calls = 0;
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    calls++;
    const request = route.request().postDataJSON();
    const prompt = request.contents.at(-1).parts[0].text as string;
    const data = JSON.parse(prompt.split('원문이다:\n')[1]);
    const block = data.blocks.at(-1);
    const output = calls === 1 ? { checkedBlockIds: data.blocks.map((block: { id: string }) => block.id), limitations: [],
      claims: [{ blockId: block.id, quote: '모든 실수', kind: 'theorem' }], issues: [{ kind: 'scope', severity: 'critical', blockIds: [block.id], quotes: ['모든 실수'],
        explanation: '양수 범위를 벗어난 일반화입니다.', resolution: 'x > 0으로 제한하세요.',
        patch: { blockId: block.id, replacement: 'x > 0인 실수의 log(x)는 정의된다.\n', introducedAssumptions: '실수 로그의 정의역은 양수다.' } }] }
      : { checkedBlockIds: data.blocks.map((block: { id: string }) => block.id), limitations: [], claims: [], issues: [] };
    expect(data.contract.scope).toBe('양수 실수');
    if (calls === 2) { expect(prompt).toContain('승인한 수정의 새 가정'); expect(block.quote).toContain('x > 0인 실수'); }
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] })}\n\n` });
  });
  await page.goto('/');
  await page.getByLabel('Google Gemini API Key').fill('review-test-key');
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구 문서', exact: true });
  await editor.getByLabel('문서 제목', { exact: true }).fill('검토 반복 이론');
  await editor.getByLabel('문서 본문 (Markdown)').fill('# 가정\n\nx > 0\n\n# 정리\n\n모든 실수의 log(x)는 정의된다.\n');
  await editor.locator('summary').click();
  await editor.getByLabel('가정·공리', { exact: true }).fill('x > 0');
  await editor.getByLabel('적용 범위', { exact: true }).fill('양수 실수');
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  await expect(editor.getByRole('status')).toContainText('v1 저장 완료');
  const review = editor.getByRole('region', { name: '문서 검토', exact: true });
  await review.locator('.theory-review-advanced > summary').click();
  await review.getByRole('button', { name: '기본 구조 확인', exact: true }).click();
  await expect(review.getByRole('region', { name: '작성하지 않은 연구 기준' })).toContainText('연구 기준 4개가 비어 있습니다');
  await expect(review.getByRole('region', { name: '작성하지 않은 연구 기준' })).toContainText('연구 목적, 핵심 정의, 기호표, 미해결 문제');
  await expect(review.getByRole('article').first()).not.toContainText('missing_contract');
  await review.getByRole('button', { name: '검토 전송 미리보기', exact: true }).click();
  const preview = review.getByRole('region', { name: '검토 전송 미리보기' });
  await expect(preview.getByRole('heading', { name: 'AI에 보낼 내용 확인' })).toBeVisible();
  await expect(preview).toContainText('아직 분석 결과가 아닙니다');
  await expect(preview.getByRole('region', { name: '전송 문단 4' })).toContainText('모든 실수');
  await expect(preview.locator('details').filter({ hasText: '전송 요청의 기술 정보' })).not.toHaveAttribute('open', '');
  expect(calls).toBe(0);
  await review.getByRole('button', { name: '이 범위로 LLM 검토 실행' }).click();
  await expect(review).toContainText('양수 범위를 벗어난 일반화');
  await expect(review).toContainText('새 가정: 실수 로그의 정의역은 양수다.');
  expect(calls).toBe(1);
  const approve = review.getByRole('button', { name: '수정 diff 승인 · 새 버전 저장', exact: true });
  await expect(approve).toBeDisabled();
  await review.getByRole('button', { name: '수정 영향 범위 확인' }).click();
  await expect(review.getByRole('region', { name: '수정 영향 범위', exact: true })).toContainText('새 가정 — 전체 문서 재검사 후보');
  expect(calls).toBe(1);
  page.once('dialog', dialog => dialog.accept()); await approve.click();
  await expect(editor.getByRole('status').filter({ hasText: 'v2으로 수정 적용' })).toBeVisible();
  await expect(editor.getByLabel('문서 본문 (Markdown)')).toHaveValue(/x > 0인 실수/);
  await expect(review).toContainText('오래된 버전의 결과');
  await expect(review).toContainText('사용 1/3회');
  await review.getByRole('button', { name: '현재 버전의 수정 영향 재검사 범위 선택' }).click();
  await expect(review).toContainText('현재 버전 재검사 후보 4블록 · 실제 검사 0/4');
  await review.getByLabel('재개 또는 종료 사유', { exact: true }).fill('범위를 양수로 수정했으므로 새 버전을 재검사한다.');
  await review.getByRole('button', { name: '중단 사유 확인 · 수동 재개 허용' }).click();
  await review.getByRole('button', { name: '검토 전송 미리보기', exact: true }).click();
  await review.getByRole('button', { name: '이 범위로 LLM 검토 실행' }).click();
  await expect(review).toContainText('확인한 범위에서 구조 문제 없음');
  await expect(review).toContainText('사용 2/3회');
  await expect(review).toContainText('현재 버전 재검사 후보 4블록 · 실제 검사 4/4');
  expect(calls).toBe(2);
  page.once('dialog', dialog => dialog.accept());
  await review.getByRole('button', { name: '재검사 결과 확인 · Issue 해결 표시' }).click();
  await expect(review).toContainText('재검사 후 사용자 해결 표시');
  const reportReady = page.waitForEvent('download');
  await review.getByRole('button', { name: '검토 보고서 내보내기', exact: true }).nth(1).click();
  const report = await readFile((await (await reportReady).path())!, 'utf8');
  expect(report).toContain('사용자 해결 표시');
  expect(report).toContain('실수 로그의 정의역은 양수다.');
  expect(report).toContain('수정 영향 범위 (적용 전 고정 승인 이력)');
  expect(report).not.toContain('review-test-key');
  await editor.getByRole('button', { name: '닫기', exact: true }).click();
  await page.locator('#open-settings-btn').click();
  const ready = page.waitForEvent('download'); await page.getByRole('button', { name: '작업공간 백업', exact: true }).click();
  const backup = (await (await ready).path())!;
  const other = await browser.newContext();
  try {
    const restored = await other.newPage(); await restored.goto('/');
    await expect(restored.getByRole('heading', { name: '연구 AI 환경 설정 (BYOK)' })).toBeVisible();
    restored.once('dialog', dialog => dialog.accept());
    await restored.getByLabel('Qaxiom 작업공간 백업 파일').setInputFiles(backup);
    await expect(restored.getByRole('status').filter({ hasText: '작업공간을 복원했습니다' })).toBeVisible();
    await restored.locator('.modal-close-btn').click();
    await restored.getByRole('button', { name: '연구 문서', exact: true }).click();
    const restoredEditor = restored.getByRole('dialog', { name: '연구 문서', exact: true });
    await restoredEditor.getByRole('button', { name: '검토 반복 이론 · v2' }).click();
    await expect(restoredEditor.getByRole('region', { name: '문서 검토', exact: true })).toContainText('확인한 범위에서 구조 문제 없음');
    await expect(restoredEditor).toContainText('적용됨 — 사용자 해결 확인');
    await expect(restoredEditor).toContainText('양수 범위를 벗어난 일반화');
    await expect(restoredEditor).toContainText('사용 2/3회');
    await restoredEditor.getByRole('button', { name: '현재 버전의 수정 영향 재검사 범위 선택' }).click();
    await expect(restoredEditor).toContainText('현재 버전 재검사 후보 4블록 · 실제 검사 4/4');
  } finally { await other.close(); }
});

test('blocks repeated issues until a recorded confirmation and preserves explicit closure across reloads', async ({ page }) => {
  let calls = 0;
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    calls++;
    const prompt = route.request().postDataJSON().contents.at(-1).parts[0].text as string;
    const data = JSON.parse(prompt.split('원문이다:\n')[1]); const block = data.blocks[0];
    const output = { checkedBlockIds: [block.id], limitations: [], claims: [], issues: [{ kind: 'scope', severity: 'warning',
      blockIds: [block.id], quotes: ['연구 가정'], explanation: '조건을 명시해야 합니다.', resolution: '범위를 확인하세요.', patch: null }] };
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] })}\n\n` });
  });
  await page.goto('/'); await page.getByLabel('Google Gemini API Key').fill('review-test-key');
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구 문서', exact: true });
  await editor.getByLabel('문서 제목', { exact: true }).fill('반복 Issue 종료');
  await editor.getByLabel('문서 본문 (Markdown)').fill('연구 가정의 범위를 정리한다.');
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  const review = editor.getByRole('region', { name: '문서 검토', exact: true });
  await review.locator('.theory-review-advanced > summary').click();
  for (let i = 1; i <= 2; i++) {
    await review.getByRole('button', { name: '검토 전송 미리보기', exact: true }).click();
    await review.getByRole('button', { name: '이 범위로 LLM 검토 실행' }).click();
    await expect(review).toContainText(`사용 ${i}/3회`);
  }
  await expect(review.getByRole('region', { name: '검토 중단 사유' })).toContainText('동일 근거의 Issue 반복 후보');
  await expect(review.getByRole('button', { name: '검토 전송 미리보기', exact: true })).toBeDisabled();
  await page.reload(); await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  await editor.getByRole('button', { name: '반복 Issue 종료 · v1' }).click();
  await review.locator('.theory-review-advanced > summary').click();
  await expect(review).toContainText('동일 근거의 Issue 반복 후보'); expect(calls).toBe(2);
  await review.getByLabel('재개 또는 종료 사유', { exact: true }).fill('원문 조건을 다시 확인하되 미해결 상태는 유지한다.');
  await review.getByRole('button', { name: '중단 사유 확인 · 수동 재개 허용' }).click();
  await review.getByRole('button', { name: '검토 전송 미리보기', exact: true }).click(); expect(calls).toBe(2);
  await review.getByRole('button', { name: '이 범위로 LLM 검토 실행' }).click();
  await expect(review).toContainText('사용 3/3회');
  await expect(review.getByRole('region', { name: '검토 중단 사유' })).toBeVisible();
  await review.getByLabel('재개 또는 종료 사유', { exact: true }).fill('범위 문제는 미해결로 남기고 이번 검토를 종료한다.');
  await review.getByRole('button', { name: '이번 검토 종료 · 판정은 유지' }).click();
  await expect(review.getByRole('region', { name: '종료된 검토' })).toContainText('정합성 통과가 아닙니다');
  await page.reload(); await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  await editor.getByRole('button', { name: '반복 Issue 종료 · v1' }).click();
  await review.locator('.theory-review-advanced > summary').click();
  await expect(review.getByRole('region', { name: '종료된 검토' })).toBeVisible();
  await expect(review).toContainText('미해결'); expect(calls).toBe(3);
  page.once('dialog', dialog => dialog.accept());
  await review.getByRole('button', { name: '새 검토 시작 · 이전 기록 보존' }).click();
  await expect(review).toContainText('사용 0/3회');
  await review.getByText('이전 검토 회차 기록', { exact: true }).click();
  await expect(review).toContainText('범위 문제는 미해결로 남기고 이번 검토를 종료한다'); expect(calls).toBe(3);
});

test('persists a split review plan and resumes the next unchecked chunk after reload with explicit approval', async ({ page }) => {
  let calls = 0; const checked: string[] = [];
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    const prompt = route.request().postDataJSON().contents.at(-1).parts[0].text as string;
    const data = JSON.parse(prompt.split('원문이다:\n')[1]);
    expect(data.blocks).toHaveLength(1); expect(data.contract.assumptions).toBe('각 요청에 포함할 필수 가정');
    const id = data.blocks[0].id; expect(checked).not.toContain(id); checked.push(id); calls++;
    const output = { checkedBlockIds: [id], limitations: [], claims: [], issues: [] };
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] })}\n\n` });
  });
  await page.goto('/'); await page.getByLabel('Google Gemini API Key').fill('review-test-key');
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구 문서', exact: true });
  await editor.getByLabel('문서 제목', { exact: true }).fill('긴 문서 재개');
  await editor.getByLabel('문서 본문 (Markdown)').fill(['가'.repeat(8000), '나'.repeat(8000), '다'.repeat(8000)].join('\n\n'));
  await editor.locator('summary').click();
  await editor.getByLabel('가정·공리', { exact: true }).fill('각 요청에 포함할 필수 가정');
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  const review = editor.getByRole('region', { name: '문서 검토', exact: true });
  await review.locator('.theory-review-advanced > summary').click();
  await review.getByRole('button', { name: '선택 범위 분할 검토 계획 저장' }).click();
  await expect(review).toContainText('3구간 · 남은 3구간'); expect(calls).toBe(0);
  await review.getByRole('button', { name: '다음 미검사 구간 선택' }).click();
  await review.getByRole('button', { name: '검토 전송 미리보기', exact: true }).click(); expect(calls).toBe(0);
  await review.getByRole('button', { name: '이 범위로 LLM 검토 실행' }).click();
  await expect(review).toContainText('남은 2구간'); await expect(review).toContainText('사용 1/3회');
  await page.reload(); await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  await editor.getByRole('button', { name: '긴 문서 재개 · v1' }).click();
  await review.locator('.theory-review-advanced > summary').click();
  await expect(review).toContainText('남은 2구간'); await expect(review).toContainText('사용 1/3회'); expect(calls).toBe(1);
  await review.getByRole('button', { name: '다음 미검사 구간 선택' }).click();
  await review.getByRole('button', { name: '검토 전송 미리보기', exact: true }).click();
  await review.getByRole('button', { name: '이 범위로 LLM 검토 실행' }).click();
  await expect(review).toContainText('남은 1구간'); await expect(review).toContainText('사용 2/3회');
  await expect(review).toContainText('구간 간 논증 정합성 판정이 아닙니다');
  expect(calls).toBe(2);
});

test('retains a malformed model response as failure without claims, patches or a pass verdict', async ({ page }) => {
  await page.route('https://generativelanguage.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"claims":[],"issues":[]}' }] } }] })}\n\n` }));
  await page.goto('/'); await page.getByLabel('Google Gemini API Key').fill('review-test-key');
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구 문서', exact: true });
  await editor.getByLabel('문서 제목', { exact: true }).fill('실패 기록');
  await editor.getByLabel('문서 본문 (Markdown)').fill('검토 원문');
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  await expect(editor.getByRole('status')).toContainText('저장 완료');
  const review = editor.getByRole('region', { name: '문서 검토', exact: true });
  await review.locator('.theory-review-advanced > summary').click();
  await review.getByRole('button', { name: '검토 전송 미리보기', exact: true }).click();
  await review.getByRole('button', { name: '이 범위로 LLM 검토 실행' }).click();
  await expect(review.getByRole('alert')).toContainText('검토 응답의 구조');
  await expect(review).toContainText('검사 실패 · 판단 자료 부족');
  await expect(review).toContainText('문단 0/1개 확인 · 확인하지 않은 문단 1개');
  await expect(review.getByRole('button', { name: '수정 diff 승인 · 새 버전 저장' })).toHaveCount(0);
  await review.getByLabel('최대 검토 요청 횟수', { exact: true }).fill('1');
  await expect(review.getByRole('button', { name: '검토 전송 미리보기', exact: true })).toBeDisabled();
});

test('stops an in-flight review and persists uninspected scope without a pass verdict', async ({ page }) => {
  let release: () => void = () => {};
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 200, body: '' }).catch(() => {});
  });
  await page.goto('/'); await page.getByLabel('Google Gemini API Key').fill('review-test-key');
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구 문서', exact: true });
  await editor.getByLabel('문서 제목', { exact: true }).fill('중단 기록');
  await editor.getByLabel('문서 본문 (Markdown)').fill('아직 검사하지 않은 원문');
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  await expect(editor.getByRole('status')).toContainText('저장 완료');
  const review = editor.getByRole('region', { name: '문서 검토', exact: true });
  await review.locator('.theory-review-advanced > summary').click();
  await review.getByRole('button', { name: '검토 전송 미리보기', exact: true }).click();
  const requestStarted = page.waitForRequest('https://generativelanguage.googleapis.com/**');
  await review.getByRole('button', { name: '이 범위로 LLM 검토 실행' }).click();
  await requestStarted;
  await review.getByRole('button', { name: '검토 중단', exact: true }).click();
  await expect(review).toContainText('검사 중단 · 판단 자료 부족');
  release();
  await expect(review).toContainText('문단 0/1개 확인 · 확인하지 않은 문단 1개');
  await page.reload();
  await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: '연구 문서', exact: true });
  await reopened.getByRole('button', { name: '중단 기록 · v1' }).click();
  await expect(reopened.getByRole('region', { name: '문서 검토', exact: true })).toContainText('검사 중단 · 판단 자료 부족');
});
