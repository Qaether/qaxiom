import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../constants';
import type { CliIpcEvent, QaxiomDesktopBridge } from '../types/desktop';
import { runTurn, TASK_SPECS } from './runTurn';

function stubCliDesktop(runImpl: (runId: string, emit: (ev: CliIpcEvent) => void) => Promise<void>) {
  let listener: ((event: CliIpcEvent) => void) | null = null;
  const bridge: QaxiomDesktopBridge = {
    isDesktop: true,
    getCliStatuses: vi.fn(),
    openCliLogin: vi.fn(),
    abortCli: vi.fn().mockResolvedValue(undefined),
    onCliEvent: cb => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    runCli: vi.fn().mockImplementation(req => runImpl(req.runId, ev => listener?.(ev)))
  };
  vi.stubGlobal('window', { qaxiomDesktop: bridge });
}

describe('harness runTurn', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('defines task specs for all active call sites', () => {
    expect(Object.keys(TASK_SPECS).sort()).toEqual(['chat', 'contract_suggestion', 'document_analysis', 'wiki_curate']);
    expect(TASK_SPECS.contract_suggestion.defaultTimeoutMs).toBe(120_000);
    expect(TASK_SPECS.contract_suggestion.maxResponseChars).toBe(20_000);
    expect(TASK_SPECS.document_analysis.maxResponseChars).toBe(2_000_000);
  });

  it('accumulates streamed text and returns TurnResult', async () => {
    stubCliDesktop(async (runId, emit) => {
      emit({ runId, type: 'session', sessionId: 'thread-1' });
      emit({ runId, type: 'chunk', chunk: 'Hello ' });
      emit({ runId, type: 'chunk', chunk: 'world' });
      emit({ runId, type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
      emit({ runId, type: 'finish' });
    });

    const chunks: string[] = [];
    const result = await runTurn(
      {
        kind: 'chat',
        messages: [{ id: 'm1', role: 'user', content: 'Hi', timestamp: 1 }],
        modelId: 'codex-cli',
        researchMode: 'general',
        settings: DEFAULT_SETTINGS
      },
      {
        callbacks: {
          onChunk: chunk => chunks.push(chunk)
        }
      }
    );

    expect(result.text).toBe('Hello world');
    expect(result.cliSessionId).toBe('thread-1');
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12
    });
    expect(chunks).toEqual(['Hello ', 'world']);
  });

  it('enforces maxResponseChars and throws cleanly', async () => {
    stubCliDesktop(async (runId, emit) => {
      emit({ runId, type: 'chunk', chunk: '1234567890' });
    });

    await expect(
      runTurn({
        kind: 'contract_suggestion',
        messages: [{ id: 'm1', role: 'user', content: 'Extract', timestamp: 1 }],
        modelId: 'codex-cli',
        researchMode: 'general',
        maxResponseChars: 5,
        settings: DEFAULT_SETTINGS
      })
    ).rejects.toThrow('Response exceeded maximum length');
  });

  it('returns aborted=true when AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    stubCliDesktop(async () => {});

    const result = await runTurn(
      {
        kind: 'document_analysis',
        messages: [{ id: 'm1', role: 'user', content: 'Analyze', timestamp: 1 }],
        modelId: 'codex-cli',
        researchMode: 'document_analysis',
        settings: DEFAULT_SETTINGS
      },
      { signal: controller.signal }
    );

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });
});
