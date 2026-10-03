import { expect, test } from './fixtures/test';

test('keeps theory authoring and reference controls usable at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(() => {
    localStorage.setItem('qaxiom_user_settings_v1', JSON.stringify({ apiKeys: { gemini: 'e2e-key' }, defaultModel: 'gemini-3.8-flash' }));
  });
  await page.goto('/');

  await page.getByRole('button', { name: '대화 메뉴 열기' }).click();
  await page.getByRole('dialog', { name: '대화 메뉴' }).getByRole('button', { name: '연구 문서' }).click();
  const theory = page.getByRole('dialog', { name: '연구 문서', exact: true });
  await expect(theory).toBeVisible();
  await theory.getByLabel('문서 제목', { exact: true }).fill('좁은 화면 연구');
  await theory.getByLabel('문서 본문 (Markdown)').fill('# 가정\n\n모든 값은 양수다.');
  await theory.getByRole('button', { name: '정본 문서 만들기' }).click();
  await expect(theory.getByRole('status')).toContainText('저장 완료');
  expect(await theory.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await theory.getByRole('button', { name: '닫기', exact: true }).click();

  await page.getByRole('button', { name: '대화 메뉴 열기' }).click();
  await page.getByRole('dialog', { name: '대화 메뉴' }).getByRole('button', { name: '레퍼런스 검색' }).click();
  const references = page.getByRole('dialog', { name: '레퍼런스 검색', exact: true });
  await expect(references).toBeVisible();
  await references.getByLabel('레퍼런스 파일').scrollIntoViewIfNeeded();
  await expect(references.getByLabel('레퍼런스 파일')).toBeInViewport();
  await references.getByLabel('레퍼런스 파일').setInputFiles({
    name: `${'long-reference-name-'.repeat(4)}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from('이 원문은 좁은 화면에서 선택과 검색을 검증한다. 반복 검증용 근거다.')
  });
  await expect(references.getByRole('status')).toContainText('레퍼런스를 로컬에 저장했습니다');
  await references.getByLabel('레퍼런스에 질문').fill('좁은 화면');
  await references.getByRole('button', { name: '원문 검색' }).click();
  await expect(references.getByRole('region', { name: '검색 근거' })).toBeVisible();
  expect(await references.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});
