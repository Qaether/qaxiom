import { afterEach, expect, it, vi } from 'vitest';
import { rankImpactInWorker } from './undeclaredImpact';
import { rankUndeclaredImpact } from './impactRanking';
const input = { before: 'x', replacement: 'y', blocks: [], excludedBlockIds: [] };
class MockWorker {
  static latest: MockWorker;
  terminate = vi.fn(); postMessage = vi.fn();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { MockWorker.latest = this; }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('terminates the local Worker after its result and sends only ranking inputs', async () => {
  vi.stubGlobal('Worker', MockWorker);
  const promise = rankImpactInWorker(input, new AbortController().signal);
  expect(MockWorker.latest.postMessage).toHaveBeenCalledWith(input);
  MockWorker.latest.onmessage!({ data: { result: rankUndeclaredImpact(input) } });
  expect(await promise).toEqual(rankUndeclaredImpact(input)); expect(MockWorker.latest.terminate).toHaveBeenCalledOnce();
});
it('terminates on explicit cancel without publishing a candidate result', async () => {
  vi.stubGlobal('Worker', MockWorker); const abort = new AbortController();
  const promise = rankImpactInWorker(input, abort.signal); const rejected = expect(promise).rejects.toThrow('취소');
  abort.abort(); await rejected; expect(MockWorker.latest.terminate).toHaveBeenCalledOnce();
});
it('terminates after the 30-second deadline or a Worker error', async () => {
  vi.stubGlobal('Worker', MockWorker); vi.useFakeTimers();
  const promise = rankImpactInWorker(input, new AbortController().signal); const rejected = expect(promise).rejects.toThrow('30초');
  await vi.advanceTimersByTimeAsync(30000); await rejected; expect(MockWorker.latest.terminate).toHaveBeenCalledOnce();
  const failed = rankImpactInWorker(input, new AbortController().signal);
  MockWorker.latest.onerror!(); await expect(failed).rejects.toThrow('Worker 오류'); expect(MockWorker.latest.terminate).toHaveBeenCalledOnce();
});
