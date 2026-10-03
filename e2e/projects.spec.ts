import { test, expect } from './fixtures/test';
test('groups, renames, changes representative and splits projects while preserving document versions across reload', async ({ page }) => {
  await page.goto('/'); await page.locator('.modal-close-btn').click(); await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구 문서', exact: true });
  const manager = editor.getByRole('region', { name: '연구 프로젝트 관리', exact: true });
  for (const title of ['A', 'B']) {
    if (title === 'B') await editor.getByRole('button', { name: '새 연구 문서', exact: true }).click();
    await editor.getByLabel('문서 제목', { exact: true }).fill(title);
    await editor.getByLabel('문서 본문 (Markdown)').fill(`${title} original.`);
    await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
    await editor.locator('details[aria-label="프로젝트 관리 및 자료 설정"] > summary').click();
    await expect(manager).toContainText(`현재 프로젝트: ${title}`);
  }
  await manager.getByLabel('이동할 프로젝트').selectOption({ label: 'A · 문서 1개' });
  page.once('dialog', dialog => dialog.accept()); await manager.getByRole('button', { name: '선택 프로젝트로 문서 이동' }).click();
  await expect(manager).toContainText('현재 프로젝트: A · 문서 2개');
  await manager.getByLabel('프로젝트 이름').fill('Alpha'); await manager.getByRole('button', { name: '프로젝트 이름 저장' }).click();
  await expect(manager).toContainText('현재 프로젝트: Alpha');
  page.once('dialog', dialog => dialog.accept()); await manager.getByRole('button', { name: '현재 문서를 프로젝트 대표로 지정' }).click();
  await expect(manager).toContainText('현재 문서가 대표 문서');
  await manager.getByLabel('프로젝트 이름').fill('Gamma');
  page.once('dialog', dialog => dialog.accept()); await manager.getByRole('button', { name: '별도 프로젝트로 문서 분리' }).click();
  await expect(manager).toContainText('현재 프로젝트: Gamma · 문서 1개');
  await expect(editor.getByLabel('문서 본문 (Markdown)')).toHaveValue('B original.');
  await expect(editor.getByRole('button', { name: 'B · v1', exact: true })).toBeVisible();
  await editor.getByLabel('문서 본문 (Markdown)').fill('unsaved edit');
  await expect(manager.getByRole('button', { name: '프로젝트 이름 저장' })).toBeDisabled();
  page.once('dialog', dialog => dialog.accept()); await editor.getByRole('button', { name: 'A · v1', exact: true }).click();
  await expect(manager).toContainText('현재 프로젝트: Alpha · 문서 1개'); await expect(manager).toContainText('현재 문서가 대표 문서');
  await page.reload(); await page.locator('.modal-close-btn').click(); await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  await editor.getByRole('button', { name: 'B · v1', exact: true }).click();
  await editor.locator('details[aria-label="프로젝트 관리 및 자료 설정"] > summary').click();
  await expect(manager).toContainText('현재 프로젝트: Gamma · 문서 1개');
  await expect(editor.getByLabel('문서 본문 (Markdown)')).toHaveValue('B original.');
});
