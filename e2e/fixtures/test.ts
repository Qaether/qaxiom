import { test as base, expect } from '@playwright/test';

// Page-specific provider mocks take precedence over this context-level guard.
export const test = base.extend({
  context: async ({ context }, run) => {
    const unexpected: string[] = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (['127.0.0.1', 'localhost'].includes(url.hostname)) { await route.continue(); return; }
      unexpected.push(`${url.origin}${url.pathname}`); // Never record query keys or request bodies.
      await route.abort('blockedbyclient');
    });
    await run(context);
    expect(unexpected, 'E2E must explicitly mock every external request').toEqual([]);
  }
});
export { expect };
