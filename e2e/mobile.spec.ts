import { expect, test } from './fixtures/test';

test('keeps chat, mobile menu and settings usable at narrow widths', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(() => {
    localStorage.setItem('qaxiom_user_settings_v1', JSON.stringify({ apiKeys: { gemini: 'e2e-key' }, defaultModel: 'gemini-3.8-flash' }));
  });
  await page.goto('/');

  const menuButton = page.getByRole('button', { name: '대화 메뉴 열기' });
  const sidebar = page.getByRole('complementary', { name: '대화 메뉴' });
  await expect(menuButton).toBeVisible();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar).toBeHidden();
  await expect(page.getByRole('textbox', { name: '연구 질문 입력' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '대화 모델 선택' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await menuButton.click();
  const drawer = page.getByRole('dialog', { name: '대화 메뉴' });
  await expect(drawer).toBeVisible();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer.getByRole('button', { name: '대화 메뉴 닫기' })).toBeFocused();
  await expect(drawer.getByRole('button', { name: '설정 (API 키)' })).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(drawer.getByRole('button', { name: '설정 (API 키)' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(drawer.getByRole('button', { name: '대화 메뉴 닫기' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(menuButton).toBeFocused();

  await menuButton.click();
  await drawer.getByRole('button', { name: '새 연구 세션' }).click();
  await expect(drawer).toHaveCount(0);
  await expect(menuButton).toBeFocused();

  await page.locator('.header-right').getByRole('button', { name: '설정 (API 키)' }).click();
  const settings = page.getByRole('dialog', { name: '연구 AI 환경 설정 (BYOK)' });
  await expect(settings).toBeVisible();
  const save = settings.getByRole('button', { name: '설정 저장' });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await settings.getByRole('button', { name: '취소' }).click();
  await expect(settings).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
