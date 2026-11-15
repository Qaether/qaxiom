import { expect, test } from '@playwright/test';
import { openNewWorkspace, setupWorkspaceMocks } from './helpers';

test('imports reference document and displays it in References & Wiki', async ({ page }) => {
  await setupWorkspaceMocks(page);
  await openNewWorkspace(page, 'RAG Wiki Workspace');

  await page.getByRole('button', { name: 'Project References' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Add' }).first().click();

  // Import a markdown reference file via hidden file input
  const fileInput = dialog.locator('input[type="file"]').first();
  await fileInput.setInputFiles({
    name: 'lagrangian-notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Lagrangian\n\nThe action $S = \\int L\\,dt$ is stationary.')
  });

  await expect(page.getByText('lagrangian-notes.md')).toBeVisible({ timeout: 10_000 });
});
