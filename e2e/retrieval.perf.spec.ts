import { expect, test } from './fixtures/test';

test('measures warm browser Worker round trips for 10k and 50k selected spans', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const rows = await page.evaluate(async () => {
    const results: { spans: number; p95Ms: number; medianMs: number; hits: number }[] = [];
    const worker = new Worker('/src/services/retrieval/search.worker.ts', { type: 'module' });
    try {
      for (const size of [10_000, 50_000]) {
        const references = Array.from({ length: Math.ceil(size / 100) }, (_, index) => ({ id: `source-${index}`, name: `${index}.md`,
          text: '', contentHash: 'benchmark', role: 'external', originVersionId: null, parserVersion: 'text-v1', createdAt: 0 }));
        const referenceSpans = Array.from({ length: size }, (_, index) => {
          const text = index % 97 === 0 ? `Quantum spin coupling needle ${index} under positive boundary conditions.`
            : `Reference paragraph ${index} on thermal transport and measured domain conditions.`;
          return { id: `span-${index}`, sourceId: `source-${Math.floor(index / 100)}`, position: index % 100,
            startOffset: 0, endOffset: text.length, startLine: 1, endLine: 1, text, contentHash: 'benchmark' };
        });
        const search = () => new Promise<{ ms: number; hits: number }>((resolve, reject) => {
          const started = performance.now();
          worker.onmessage = event => event.data.error ? reject(new Error(event.data.error))
            : resolve({ ms: performance.now() - started, hits: event.data.hits.length });
          worker.onerror = event => reject(new Error(event.message));
          worker.postMessage({ data: { references, referenceSpans }, query: 'quantum spin needle' });
        });
        await search();
        const samples: number[] = [];
        let hits = 0;
        for (let sample = 0; sample < 20; sample++) {
          const result = await search(); samples.push(result.ms); hits = result.hits;
        }
        samples.sort((a, b) => a - b);
        results.push({ spans: size, medianMs: samples[9], p95Ms: samples[18], hits });
      }
    } finally { worker.terminate(); }
    return results;
  });
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.p95Ms > 0)).toBe(true);
  expect(rows.map(row => row.hits)).toEqual([12, 12]);
  console.log(`Browser Worker round trips including clone/search, excluding IndexedDB/UI: ${JSON.stringify(rows)}`);
});

test('measures the app search path from IndexedDB selection through a fresh Worker', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  const rows = await page.evaluate(async () => {
    const [{ qaxiomDatabase }, { loadReferenceSelection }] = await Promise.all([
      import('/src/services/database.ts'), import('/src/services/retrieval/references.ts')
    ]);
    const references = Array.from({ length: 500 }, (_, index) => ({ id: `db-source-${index}`, name: `${index}.md`,
      text: 'Synthetic research paragraph.\n'.repeat(100), contentHash: 'benchmark', role: 'external' as const,
      originVersionId: null, parserVersion: 'text-v1' as const, createdAt: 0 }));
    const referenceSpans = Array.from({ length: 50_000 }, (_, index) => {
      const text = index % 97 === 0 ? `Quantum spin coupling needle ${index} under positive boundary conditions.`
        : `Reference paragraph ${index} on thermal transport and measured domain conditions.`;
      return { id: `db-span-${index}`, sourceId: `db-source-${Math.floor(index / 100)}`, position: index % 100,
        startOffset: 0, endOffset: text.length, startLine: 1, endLine: 1, text, contentHash: 'benchmark' };
    });
    await qaxiomDatabase.references.bulkAdd(references);
    for (let index = 0; index < referenceSpans.length; index += 5000)
      await qaxiomDatabase.reference_spans.bulkAdd(referenceSpans.slice(index, index + 5000));
    const results: { spans: number; readMedianMs: number; readP95Ms: number; totalMedianMs: number; totalP95Ms: number; hits: number }[] = [];
    for (const size of [10_000, 50_000]) {
      const sourceIds = references.slice(0, size / 100).map(source => source.id);
      const search = async () => {
        const started = performance.now();
        const data = await loadReferenceSelection(sourceIds);
        const readMs = performance.now() - started;
        const worker = new Worker('/src/services/retrieval/search.worker.ts', { type: 'module' });
        try {
          const hits = await new Promise<number>((resolve, reject) => {
            worker.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.hits.length);
            worker.onerror = event => reject(new Error(event.message));
            worker.postMessage({ data, query: 'quantum spin needle' });
          });
          return { readMs, totalMs: performance.now() - started, hits };
        } finally { worker.terminate(); }
      };
      await search();
      const reads: number[] = [], totals: number[] = [];
      let hits = 0;
      for (let sample = 0; sample < 10; sample++) {
        const result = await search(); reads.push(result.readMs); totals.push(result.totalMs); hits = result.hits;
      }
      reads.sort((a, b) => a - b); totals.sort((a, b) => a - b);
      results.push({ spans: size, readMedianMs: reads[4], readP95Ms: reads[9],
        totalMedianMs: totals[4], totalP95Ms: totals[9], hits });
    }
    return results;
  });
  expect(rows.map(row => row.hits)).toEqual([12, 12]);
  console.log(`IndexedDB selection + fresh Worker, excluding source/hash validation and UI: ${JSON.stringify(rows)}`);
});
