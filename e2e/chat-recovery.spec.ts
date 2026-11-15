import { expect, test } from '@playwright/test';
import { createResearchNote, mockOpenAIStream, openNewWorkspace, setupWorkspaceMocks } from './helpers';

test('streams chat response and persists conversation across reload', async ({ page }) => {
  await setupWorkspaceMocks(page);
  await mockOpenAIStream(page, 'Harness response verified.');
  await openNewWorkspace(page, 'Chat Recovery Workspace');
  await createResearchNote(page, 'Gauge Note', '# Gauge\n\nInitial body.');

  const input = page.getByRole('textbox', { name: 'Enter research question' });
  await input.fill('Explain gauge symmetry briefly.');
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(page.getByText('Harness response verified.')).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await expect(page.getByText('Chat Recovery Workspace')).toBeVisible({ timeout: 10_000 });

  const persisted = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('qaxiom_workspace_v1');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const readAll = (storeName: string) =>
      new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result as Array<Record<string, unknown>>);
        req.onerror = () => reject(req.error);
      });
    const messages = await readAll('messages');
    const events = await readAll('session_events');
    db.close();
    return { messages, events };
  });

  expect(persisted.messages.some(m => m.content === 'Harness response verified.')).toBe(true);
  expect(persisted.events.some(e => e.type === 'turn_completed')).toBe(true);
});
