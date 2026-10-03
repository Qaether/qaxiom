import { expect, test } from './fixtures/test';
import { makePdf, pdfText, imagePage } from './fixtures/pdf';

test('extracts PDF pages lazily, cites page two, renders its original and restores binary backup', async ({ page, browser }) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  let payload = '';
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    payload = route.request().postData() || '';
    await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'The photon mass is zero. [[R1]]' }] } }] })}\n\n` });
  });
  await page.goto('/');
  await page.getByLabel('Google Gemini API Key').fill('pdf-test-key');
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.getByRole('button', { name: '레퍼런스 검색', exact: true }).click();
  const library = page.getByRole('dialog', { name: '레퍼런스 검색', exact: true });
  await expect(library).toBeVisible();
  expect(requests.some(url => /pdfRuntime|pdf\.worker/.test(url))).toBe(false);
  const binary = makePdf([pdfText('Introduction and scope'), `${pdfText('The photon mass is zero.')}\n${pdfText('E = m c^2 (formula extraction is not a proof)', 50, 690)}`]);
  await library.getByLabel('레퍼런스 파일', { exact: true }).setInputFiles({ name: 'research.pdf', mimeType: 'application/pdf', buffer: binary });
  await expect(library.getByRole('status')).toContainText('PDF: 텍스트 추출됨', { timeout: 15000 });
  expect(requests.some(url => /pdf\.worker/.test(url))).toBe(true);
  await library.getByLabel('레퍼런스에 질문').fill('photon mass');
  await library.getByRole('button', { name: '원문 검색', exact: true }).click();
  await expect(library.getByRole('region', { name: '검색 근거' })).toContainText('2쪽');
  await library.getByRole('button', { name: '전송 내용 미리보기' }).click();
  await library.getByRole('button', { name: '이 근거로 질문 보내기' }).click();
  await expect(page.getByRole('region', { name: '답변 근거' })).toContainText('답변에서 인용');
  expect(payload).toContain('\\"page\\":2');
  expect(payload).not.toContain(binary.toString('base64'));
  await page.getByRole('button', { name: /\[\[R1\]\].*원문 보기/ }).click();
  const source = page.getByRole('dialog', { name: '인용 원문: research.pdf' });
  await expect(source.getByLabel('PDF 원본 2쪽', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(source.locator('mark')).toContainText('photon mass');
  await source.screenshot({ path: 'test-results/pdf-page-two.png' });
  await source.getByRole('button', { name: '이전 페이지' }).click();
  await expect(source.getByLabel('PDF 원본 1쪽', { exact: true })).toBeVisible();
  await source.getByRole('button', { name: '닫기', exact: true }).click();
  await page.locator('#open-settings-btn').click();
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: '작업공간 백업', exact: true }).click();
  const backup = (await (await ready).path())!;
  const other = await browser.newContext();
  try {
    const restored = await other.newPage(); await restored.goto('/');
    await expect(restored.getByRole('heading', { name: '연구 AI 환경 설정 (BYOK)' })).toBeVisible();
    restored.once('dialog', dialog => dialog.accept());
    await restored.getByLabel('Qaxiom 작업공간 백업 파일').setInputFiles(backup);
    await expect(restored.getByRole('status').filter({ hasText: '작업공간을 복원했습니다' })).toBeVisible();
    await restored.locator('.modal-close-btn').click();
    await restored.getByRole('button', { name: /\[\[R1\]\].*원문 보기/ }).click();
    await expect(restored.getByRole('dialog', { name: '인용 원문: research.pdf' }).getByLabel('PDF 원본 2쪽', { exact: true })).toBeVisible({ timeout: 15000 });
  } finally { await other.close(); }
});

test('distinguishes image-only, mixed, encrypted and broken PDFs without publishing fake text', async ({ page }) => {
  await page.goto('/'); await page.locator('.modal-close-btn').click();
  await page.getByRole('button', { name: '레퍼런스 검색', exact: true }).click();
  const library = page.getByRole('dialog', { name: '레퍼런스 검색', exact: true });
  const upload = async (name: string, buffer: Buffer, status: string) => {
    await library.getByLabel('레퍼런스 파일', { exact: true }).setInputFiles({ name, mimeType: 'application/pdf', buffer });
    await expect(library.getByRole('status')).toContainText(status, { timeout: 15000 });
  };
  await upload('scanned.pdf', makePdf([imagePage]), '텍스트 추출 불가 · 검색 제외');
  await expect(library.getByRole('checkbox')).toHaveCount(0);
  await library.getByRole('button', { name: 'PDF 원본 보기: scanned.pdf' }).click();
  const original = page.getByRole('dialog', { name: 'PDF 원본: scanned.pdf' });
  await expect(original.getByLabel('PDF 원본 1쪽', { exact: true })).toBeVisible();
  await original.screenshot({ path: 'test-results/pdf-image-only.png' });
  await original.getByRole('button', { name: '닫기', exact: true }).click();
  await upload('mixed.pdf', makePdf([`${pdfText('Left column energy', 40, 730)}\n${pdfText('Right column scope', 310, 730)}`, imagePage]), '일부 페이지 텍스트 없음');
  await expect(library.getByRole('checkbox', { name: /mixed.pdf/ })).toBeVisible();
  await expect(library.getByRole('checkbox', { name: /mixed.pdf.*텍스트 없는 페이지 1개/ })).toBeVisible();
  await upload('encrypted.pdf', makePdf([pdfText('private fixture')], true), '암호화');
  await upload('broken.pdf', Buffer.from('%PDF-1.4 invalid fixture'), 'PDF: 실패');
  await expect(library.getByRole('checkbox')).toHaveCount(1);
  await library.getByLabel('레퍼런스에 질문').fill('energy');
  await library.getByRole('button', { name: '원문 검색', exact: true }).click();
  await expect(library.getByRole('region', { name: '검색 근거' })).toContainText('Left column energy');
  page.once('dialog', dialog => dialog.accept());
  await library.getByRole('button', { name: '미연결 PDF 원본 삭제: scanned.pdf' }).click();
  await expect(library.getByRole('status')).toContainText('PDF 원본을 삭제했습니다');
  await expect(library.getByRole('button', { name: 'PDF 원본 보기: scanned.pdf' })).toHaveCount(0);
  await library.getByRole('button', { name: '닫기', exact: true }).click();
  await page.reload();
  await page.locator('.modal-close-btn').click();
  await page.getByRole('button', { name: '레퍼런스 검색', exact: true }).click();
  await expect(page.getByRole('button', { name: 'PDF 원본 보기: scanned.pdf' })).toHaveCount(0);
});
