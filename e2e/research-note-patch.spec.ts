import { expect, test } from '@playwright/test';
import { createResearchNote, mockOpenAIStream, openNewWorkspace, setupWorkspaceMocks } from './helpers';

test('stages propose_patch hunk diff in research note workspace', async ({ page }) => {
  await setupWorkspaceMocks(page);
  await openNewWorkspace(page, 'Research Patch Workspace');
  await createResearchNote(
    page,
    'Noether Theorem Note',
    '# Draft\n\nOld premise line.\n\nUnchanged conclusion.'
  );

  const patchReply = [
    'Updated the premise line via propose_patch.',
    '',
    '```propose_patch:document.md',
    JSON.stringify({
      hunks: [
        {
          targetText: 'Old premise line.',
          replacementText: 'Verified Noether premise line.',
          rationale: 'Clarify symmetry premise'
        }
      ]
    }),
    '```'
  ].join('\n');
  await mockOpenAIStream(page, patchReply);

  const chatInput = page.getByRole('textbox', { name: 'Enter research question' });
  await chatInput.fill('Clarify the premise line.');
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(page.getByText('Updated the premise line via propose_patch.')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Verified Noether premise line.')).toBeVisible({ timeout: 10_000 });
});
