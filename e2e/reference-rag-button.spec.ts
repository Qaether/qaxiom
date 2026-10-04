import { expect, test } from './fixtures/test';

test('opens and closes the integrated reference RAG search and returns local BM25 evidence', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true,
      value: async () => ({ name: 'research-folder' }) });
  });
  await page.goto('/');
  await page.getByLabel('프로젝트 이름').fill('RAG 버튼 확인');
  await page.getByRole('button', { name: '로컬 폴더 지정' }).click();
  await page.getByRole('button', { name: '채팅 화면 열기' }).click();

  await page.getByRole('button', { name: '새 연구노트' }).click();
  const editor = page.locator('dialog.theory-workspace');
  await editor.getByLabel('문서 제목', { exact: true }).fill('검색 확인 문서');
  await editor.getByLabel('문서 본문 (Markdown)').fill('중력파 연구 노트');
  await editor.getByRole('button', { name: '문서 저장' }).click();

  await expect(editor.locator('.note-reference-shelf-bar')).toHaveCount(0);
  const addReference = editor.getByRole('button', { name: '레퍼런스 추가' });
  await expect(addReference.locator('span')).toHaveCount(0);
  await expect(addReference).toHaveAttribute('data-tooltip', '레퍼런스 추가');
  await addReference.hover();
  await expect.poll(() => addReference.evaluate(element => getComputedStyle(element, '::after').opacity)).toBe('1');
  expect(await addReference.evaluate(element => getComputedStyle(element, '::after').content)).toContain('레퍼런스 추가');
  await addReference.click();
  const referenceModal = page.getByRole('dialog', { name: '레퍼런스 추가' });
  await referenceModal.getByRole('button', { name: '새 파일 등록' }).click();
  await referenceModal.getByLabel('파일 선택', { exact: true }).setInputFiles({
    name: 'rag-check.txt', mimeType: 'text/plain', buffer: Buffer.from('중력파 검출기는 시공간의 미세한 변화를 측정한다.')
  });
  await expect(referenceModal).toContainText('현재 노트에 연결되었습니다');
  await referenceModal.getByRole('button', { name: '적용하기' }).click();
  await expect(referenceModal).toHaveCount(0);

  const drawer = editor.getByLabel('통합 에디터 검색');
  await expect(drawer).toHaveCount(0);
  await editor.getByRole('button', { name: '통합 검색' }).click();
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: '레퍼런스 RAG 검색' }).click();
  await expect(drawer.getByText('이 노트 레퍼런스만 (1개)', { exact: true })).toBeVisible();
  await drawer.getByPlaceholder('레퍼런스 수식, 용어, 키워드 검색 (Enter)…').fill('중력파');
  await drawer.getByRole('button', { name: '검색', exact: true }).click();
  await expect(drawer).toContainText('검색 결과 1건 발견');
  await expect(drawer).toContainText('시공간의 미세한 변화');

  await drawer.getByRole('button', { name: '닫기' }).click();
  await expect(drawer).toHaveCount(0);
  await editor.getByRole('button', { name: '통합 검색' }).click();
  await expect(drawer).toBeVisible();
});
