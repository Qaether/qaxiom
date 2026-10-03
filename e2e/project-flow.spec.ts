import { expect, test } from './fixtures/test';

test('opens project setup before chat and enters document work from the primary sidebar action', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => ({ name: 'research-folder' })
    });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('button', { name: '채팅 화면 열기' })).toBeDisabled();
  await page.getByLabel('프로젝트 이름').fill('새 물리 이론');
  await page.getByRole('button', { name: '로컬 폴더 지정' }).click();
  await expect(page.getByText('선택한 폴더: research-folder')).toBeVisible();
  await page.getByRole('button', { name: '채팅 화면 열기' }).click();
  await expect(page.locator('.sidebar-project-card').getByText('새 물리 이론', { exact: true })).toBeVisible();
  await expect(page.locator('.header-project-chip').getByText('새 물리 이론', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '새 연구 문서' })).toBeVisible();
  await expect(page.getByRole('button', { name: '새 대화' })).toBeVisible();
  await expect(page.getByRole('button', { name: '레퍼런스 검색' })).toBeVisible();
  await page.getByRole('button', { name: '새 연구 문서' }).click();
  const editor = page.locator('dialog.theory-workspace');
  await expect(editor).toHaveAccessibleName('새 연구 문서');
  await expect(editor.getByLabel('연구 작업 모드')).toHaveCount(0);
  await expect(editor.getByRole('heading', { name: '1. 문서 작성' })).toBeVisible();
  await expect(editor.getByRole('navigation', { name: '정본 문서 목록' })).toHaveCount(0);
  await expect(editor.getByRole('complementary', { name: 'AI 분석과 검토 결과' })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: '문서 저장' })).toBeDisabled();
  await editor.getByLabel('문서 제목', { exact: true }).fill('새 가설');
  await editor.getByLabel('문서 본문 (Markdown)').fill('# 새 가설\n\n내용');
  await editor.getByRole('button', { name: '문서 저장' }).click();
  await expect(editor).toContainText('v1 저장 완료');
  await expect(editor).toHaveAccessibleName('새 가설');
  await expect(editor.getByRole('complementary', { name: 'AI 분석과 검토 결과' }).getByRole('button', { name: 'AI로 문서 분석' })).toBeVisible();
  await expect(editor.getByRole('button', { name: '새 연구 문서' })).toHaveCount(0);
  await editor.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(page.getByRole('button', { name: '새 가설 v1' })).toBeVisible();
  await page.reload();
  await expect(page.locator('main.project-start[role="status"]')).toHaveCount(0);
  const projectSetup = page.getByRole('heading', { level: 1, name: 'Projects' });
  await expect(projectSetup).toBeVisible();
  await expect(page.getByRole('region', { name: 'Projects' })).toContainText('새 물리 이론');
  await expect(page.getByRole('region', { name: 'Projects' })).toContainText('research-folder');
});
