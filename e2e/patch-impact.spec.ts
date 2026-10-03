import { test, expect } from './fixtures/test';

test('previews dependency impact before patch approval, nominates only successor scope and never resolves a partial recheck', async ({ page }) => {
  let calls = 0;
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    calls++;
    const prompt = route.request().postDataJSON().contents.at(-1).parts[0].text as string;
    const input = JSON.parse(prompt.split('원문이다:\n')[1]);
    expect(input.graphContext).toBeUndefined();
    const block = input.blocks.find((b: { quote: string }) => b.quote.startsWith('A '));
    if (calls === 2) {
      expect(input.blocks).toHaveLength(3); expect(prompt).not.toContain('U mentions revised.');
      expect(input.omittedBlockIds).toHaveLength(1); expect(block.quote).toContain('A revised.');
    }
    const result = calls === 1 ? { checkedBlockIds: input.blocks.map((b: { id: string }) => b.id), limitations: [], claims: [],
      issues: [{ kind: 'argument', severity: 'warning', blockIds: [block.id], quotes: ['A original.'], explanation: 'A 수정 후보', resolution: '연결된 결과도 재검사', patch: { blockId: block.id, replacement: 'A revised.\n\n', introducedAssumptions: '' } }] }
      : { checkedBlockIds: input.blocks.map((b: { id: string }) => b.id), limitations: [], claims: [], issues: [] };
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] })}\n\n` });
  });
  await page.goto('/'); await page.getByLabel('Google Gemini API Key').fill('impact-fake-key');
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.locator('#header-model-select').selectOption('gemini-3.1-pro-preview');
  await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구 문서', exact: true });
  await editor.getByLabel('문서 제목', { exact: true }).fill('의존 영향 재검사');
  await editor.getByLabel('문서 본문 (Markdown)').fill('A original.\n\nB needs A.\n\nC needs B.\n\nU mentions revised.');
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  const review = editor.getByRole('region', { name: '문서 검토', exact: true });
  await review.locator('.theory-review-advanced > summary').click();
  await review.getByRole('button', { name: '기본 구조 확인', exact: true }).click();
  await review.locator('summary').filter({ hasText: '주장 후보' }).click();
  const claims = review.getByRole('combobox', { name: /^주장 채택 상태/ });
  for (let i = 0; i < 4; i++) await claims.nth(i).selectOption('accepted');
  const relations = editor.getByRole('region', { name: '주장 관계와 Wiki' });
  await editor.locator('details[aria-label="고급 문서 도구"] > summary').click();
  await relations.getByRole('button', { name: '관계 목록 새로고침' }).click();
  await expect(relations.getByLabel('출발 주장', { exact: true }).locator('option')).toHaveCount(5);
  const ids = await relations.getByLabel('출발 주장', { exact: true }).locator('option').evaluateAll(elements => elements.map(e => (e as HTMLOptionElement).value).filter(Boolean));
  for (const [from, to] of [[1, 0], [2, 1]]) {
    await relations.getByLabel('출발 주장', { exact: true }).selectOption(ids[from]);
    await relations.getByLabel('도착 주장 또는 구간').selectOption(ids[to]);
    await relations.getByLabel('의존성 종류').selectOption('proof');
    await relations.getByLabel('관계 승인 사유').fill(`의존 ${from} → ${to}`);
    await relations.getByRole('button', { name: '관계 승인 미리보기', exact: true }).click();
    await relations.getByRole('button', { name: '이 관계 승인·저장' }).click();
    await expect(relations.getByRole('status')).toContainText('승인·저장');
  }
  await review.getByRole('button', { name: '검토 전송 미리보기', exact: true }).click();
  await review.getByRole('button', { name: '이 범위로 LLM 검토 실행' }).click();
  const impact = review.getByRole('region', { name: '수정 영향 범위', exact: true });
  await expect(impact.getByRole('button', { name: '수정 diff 승인 · 새 버전 저장' })).toBeDisabled();
  await impact.getByRole('button', { name: '수정 영향 범위 확인' }).click();
  await expect(impact).toContainText('적용 전 목표 3블록 · 추가 전제 0블록 · 관계 2개');
  await expect(impact).not.toContainText('U mentions revised.'); expect(calls).toBe(1);
  page.once('dialog', dialog => dialog.accept());
  await impact.getByRole('button', { name: '수정 diff 승인 · 새 버전 저장' }).click();
  await expect(editor.getByRole('status').filter({ hasText: 'v2으로 수정 적용' })).toBeVisible();
  await impact.getByRole('button', { name: '현재 버전의 수정 영향 재검사 범위 선택' }).click();
  await expect(impact).toContainText('현재 버전 재검사 후보 3블록 · 실제 검사 0/3');
  await expect(review.getByRole('checkbox', { name: /문단 4/ })).not.toBeChecked();
  const candidates = impact.getByRole('region', { name: '미선언 수정 영향 후보', exact: true });
  await candidates.getByRole('button', { name: '미선언 수정 영향 후보 찾기' }).click();
  await expect(candidates).toContainText('범위 밖 탐색 1블록 · 표시 후보 1개 · 추가 일치 후보 미표시 0개');
  await expect(candidates).toContainText('U mentions revised.');
  await expect(candidates).toContainText('추가 용어 일치: revised');
  const candidate = candidates.getByRole('checkbox', { name: '미선언 후보 블록 4', exact: true });
  await expect(candidate).not.toBeChecked(); expect(calls).toBe(1);
  await candidate.check();
  await candidates.getByRole('button', { name: '선택 후보와 기존 영향 범위를 재검사 대상으로 지정' }).click();
  await expect(candidates).toContainText('명시 지정 4블록 · 실제 검사 0/4');
  await expect(review.getByRole('checkbox', { name: /^문단 4/ })).toBeChecked();
  expect(calls).toBe(1);
  await impact.getByRole('button', { name: '현재 버전의 수정 영향 재검사 범위 선택' }).click();
  await expect(candidate).toHaveCount(0);
  await expect(review.getByRole('checkbox', { name: /^문단 4/ })).not.toBeChecked();
  await review.getByRole('button', { name: '검토 전송 미리보기', exact: true }).click();
  expect(calls).toBe(1);
  await review.getByRole('button', { name: '이 범위로 LLM 검토 실행' }).click();
  await expect(impact).toContainText('현재 버전 재검사 후보 3블록 · 실제 검사 3/3');
  await expect(review).toContainText('판단 자료 부족');
  await expect(review.getByRole('button', { name: '재검사 결과 확인 · Issue 해결 표시' })).toHaveCount(0);
  expect(calls).toBe(2);
  await page.reload(); await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  await editor.getByRole('button', { name: '의존 영향 재검사 · v2' }).click();
  await impact.getByRole('button', { name: '현재 버전의 수정 영향 재검사 범위 선택' }).click();
  await expect(impact).toContainText('현재 버전 재검사 후보 3블록 · 실제 검사 3/3');
  expect(calls).toBe(2);
});
