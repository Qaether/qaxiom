import { expect, test } from '@playwright/test';
import { createResearchNote, openNewWorkspace, setupWorkspaceMocks } from './helpers';

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

test('attaching a paper via Add reference sends its excerpts to Chat', async ({ page }) => {
  await setupWorkspaceMocks(page);
  await openNewWorkspace(page, 'Pinned Reference Chat Workspace');
  await createResearchNote(page, 'Hamiltonian Note', '# Note\n\nChecking attached paper.');

  // Open top-bar "Add reference" modal on the saved research note
  await page.getByRole('button', { name: 'Add reference' }).click();
  const modal = page.getByRole('dialog', { name: 'Add References' });
  await expect(modal).toBeVisible({ timeout: 10_000 });

  // Switch to the upload/new-file tab and upload a markdown paper
  await modal.getByRole('button', { name: /New File|Upload/i }).first().click();
  const fileInput = modal.locator('input[type="file"]').first();
  await fileInput.setInputFiles({
    name: 'hamiltonian-paper.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Hamiltonian Eigenvalues\n\nThe ground state energy is E_0 = 1/2 hbar omega.')
  });

  await expect(modal.getByText('hamiltonian-paper.md')).toBeVisible({ timeout: 10_000 });
  await modal.getByRole('button', { name: 'Apply' }).click();

  let capturedRequestBody = '';
  await page.route('https://api.openai.com/v1/responses', async route => {
    capturedRequestBody = route.request().postData() ?? '';
    const body = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Based on [[R1]], E_0 = 1/2 hbar omega.' })}\n\n`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 40, output_tokens: 15, total_tokens: 55 } }
      })}\n\n`,
      'data: [DONE]\n\n'
    ].join('');
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body
    });
  });

  const chatInput = page.getByRole('textbox', { name: 'Enter research question' });
  await chatInput.fill('What is the ground state energy in the attached paper?');
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(page.getByText('Based on [[R1]], E_0 = 1/2 hbar omega.')).toBeVisible({ timeout: 10_000 });
  expect(capturedRequestBody).toContain('qaxiom_reference_data');
  expect(capturedRequestBody).toContain('hamiltonian-paper.md');
  expect(capturedRequestBody).toContain('E_0 = 1/2 hbar omega');
});
