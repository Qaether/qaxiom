import { expect, test } from './fixtures/test';

test('previews only a selected external text span for document review', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => ({ name: 'research-folder' })
    });
  });
  await page.goto('/');
  await page.getByLabel('프로젝트 이름').fill('대조 연구');
  await page.getByRole('button', { name: '로컬 폴더 지정' }).click();
  await page.getByRole('button', { name: '채팅 화면 열기' }).click();
  await page.getByRole('button', { name: '레퍼런스 검색' }).click();
  const library = page.getByRole('dialog', { name: '레퍼런스 검색' });
  await expect(library.getByLabel('프로젝트 자료 범위 (정본 선택 전)')).toHaveCount(0);
  await library.getByLabel('레퍼런스 파일').setInputFiles({
    name: 'independent.txt', mimeType: 'text/plain', buffer: Buffer.from('Independent observation: mass is positive.')
  });
  await expect(library.getByRole('status')).toContainText('로컬에 저장');
  await library.getByRole('button', { name: '닫기' }).click();
  await page.getByRole('button', { name: '새 연구 문서' }).click();
  const editor = page.locator('dialog.theory-workspace');
  await editor.getByLabel('문서 제목', { exact: true }).fill('질량 가설');
  await editor.getByLabel('문서 본문 (Markdown)').fill('질량은 양수다.');
  await editor.getByRole('button', { name: '문서 저장' }).click();
  await editor.getByRole('button', { name: 'AI로 문서 분석' }).click();
  await editor.locator('.theory-external-advanced > summary').click();
  const external = editor.getByRole('region', { name: '독립 외부 원문 대조' });
  await external.getByLabel('대조할 이론 블록').selectOption({ index: 1 });
  await external.getByLabel('대조할 외부 자료').selectOption({ label: 'independent.txt' });
  await external.getByLabel('대조할 원문 구간').selectOption({ index: 1 });
  await external.getByLabel('대조 이론의 가정·정의·범위').fill('질량의 정의가 동일하다');
  await external.getByLabel('대조 원문의 가정·정의·범위').fill('측정 범위가 같다');
  await external.getByRole('button', { name: '외부 대조 쌍 추가' }).click();
  await external.getByRole('button', { name: '외부 대조 전송 미리보기' }).click();
  const preview = external.getByRole('region', { name: '외부 대조 전송 미리보기' });
  await expect(preview).toContainText('independent.txt');
  await expect(preview).toContainText('Independent observation: mass is positive.');
  await expect(preview).toContainText('질량은 양수다.');
  await expect(external.getByText('외부 주장 추출 후보')).toHaveCount(0);
});
