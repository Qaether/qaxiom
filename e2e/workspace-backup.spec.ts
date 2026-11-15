import { expect, test } from '@playwright/test';
import { openNewWorkspace, setupWorkspaceMocks } from './helpers';

test('exports v25 workspace backup without leaking API keys', async ({ page }) => {
  await setupWorkspaceMocks(page, 'sk-secret-do-not-export-999');
  await openNewWorkspace(page, 'Backup Workspace');

  await page.getByRole('button', { name: 'Settings (API Keys)' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Export Workspace' }).click();
  const download = await downloadPromise;

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const parsed = JSON.parse(raw) as { format: string; version: number; data: Record<string, unknown> };

  expect(parsed.format).toBe('qaxiom-workspace');
  expect(parsed.version).toBe(25);
  expect(Array.isArray(parsed.data.sessionEvents)).toBe(true);
  expect(raw).not.toContain('sk-secret-do-not-export-999');
});
