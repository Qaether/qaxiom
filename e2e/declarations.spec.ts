import { test, expect } from './fixtures/test';

test('saves explicit declaration source, checks proof cycles and scoped symbols, and rechecks corrected declarations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '연구 AI 환경 설정 (BYOK)' })).toBeVisible();
  await page.locator('.modal-close-btn').click();
  await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구 문서', exact: true });
  await editor.getByLabel('문서 제목', { exact: true }).fill('기호 범위와 의존성');
  const original = '# 정의\n\nx는 실수 변수다.\n\n# 결과\n\ny는 결과다.\n';
  await editor.getByLabel('문서 본문 (Markdown)').fill(original);
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  await expect(editor.getByRole('status')).toContainText('v1 저장 완료');
  await editor.locator('details[aria-label="고급 문서 도구"] > summary').click();
  const guide = editor.getByRole('group', { name: '기호와 의존성 선언' });
  // Native details is a group in the accessibility tree; its source IDs are visible locally.
  await guide.locator('summary').click();
  const ids = await guide.locator('code').allTextContents();
  await guide.getByRole('button', { name: '기호·의존성 선언 템플릿 추가' }).click();
  await expect(editor.getByLabel('문서 본문 (Markdown)')).toHaveValue(/qaxiom-declarations/);
  const data = { symbols: [
    { name: 'x', meaning: '실수', definedAt: ids[1], scope: [ids[1]] },
    { name: 'x', meaning: '확률', definedAt: ids[3], scope: [ids[1]] }
  ], uses: [{ name: 'x', at: ids[3] }], dependencies: [
    { from: ids[1], to: ids[3], kind: 'proof' }, { from: ids[3], to: ids[1], kind: 'proof' }
  ] };
  const markdown = original + '\n\n```qaxiom-declarations\n' + JSON.stringify(data) + '\n```\n';
  await editor.getByLabel('문서 본문 (Markdown)').fill(markdown);
  await editor.getByRole('button', { name: '새 버전 저장' }).click();
  await expect(editor.getByRole('status')).toContainText('v2 저장 완료');
  const review = editor.getByRole('region', { name: '문서 검토', exact: true });
  await review.locator('.theory-review-advanced > summary').click();
  await review.getByRole('button', { name: '기본 구조 확인', exact: true }).click();
  await expect(review).toContainText('증명 의존 순환 후보');
  await expect(review).toContainText('기호 정의 충돌');
  await expect(review).toContainText('정의하지 않은 기호');
  const corrected = { symbols: [{ name: 'x', meaning: '실수', definedAt: ids[1], scope: [] }], uses: data.uses,
    dependencies: data.dependencies.map(edge => ({ ...edge, kind: 'concept' })) };
  await editor.getByLabel('문서 본문 (Markdown)').fill(original + '\n\n```qaxiom-declarations\n' + JSON.stringify(corrected) + '\n```\n');
  await editor.getByRole('button', { name: '새 버전 저장' }).click();
  await expect(editor.getByRole('status')).toContainText('v3 저장 완료');
  await review.getByRole('button', { name: '기본 구조 확인', exact: true }).click();
  await expect(review.getByRole('article').first()).toContainText('기본 구조 확인');
  await expect(review.getByRole('article').first()).not.toContainText('증명 의존 순환 후보');
  await expect(review.getByRole('article').first()).not.toContainText('정의하지 않은 기호');
  await expect(review.getByRole('article').first()).not.toContainText('기호 정의 충돌');
  await page.reload();
  await expect(page.getByRole('heading', { name: '연구 AI 환경 설정 (BYOK)' })).toBeVisible();
  await page.locator('.modal-close-btn').click();
  await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  const reopened = page.getByRole('dialog', { name: '연구 문서', exact: true });
  await reopened.getByRole('button', { name: '기호 범위와 의존성 · v3' }).click();
  await expect(reopened.getByLabel('문서 본문 (Markdown)')).toHaveValue(/"concept"/);
  await expect(reopened.getByRole('region', { name: '문서 검토', exact: true })).toContainText('기호 의미·논증·단위·외부 호환성은 미검증');
});
