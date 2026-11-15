import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../constants';
import { runTurn, TASK_SPECS } from './runTurn';

describe('harness runTurn', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defines task specs for all active call sites', () => {
    expect(Object.keys(TASK_SPECS).sort()).toEqual(['chat', 'contract_suggestion', 'document_analysis', 'wiki_curate']);
    expect(TASK_SPECS.contract_suggestion.defaultTimeoutMs).toBe(120_000);
    expect(TASK_SPECS.contract_suggestion.maxResponseChars).toBe(20_000);
    expect(TASK_SPECS.document_analysis.maxResponseChars).toBe(2_000_000);
  });

  it('accumulates streamed text and returns TurnResult', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"Hello "}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"world"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const chunks: string[] = [];
    const result = await runTurn(
      {
        kind: 'chat',
        messages: [{ id: 'm1', role: 'user', content: 'Hi', timestamp: 1 }],
        modelId: 'gpt-6-astra',
        researchMode: 'general',
        settings: {
          ...DEFAULT_SETTINGS,
          apiKeys: { ...DEFAULT_SETTINGS.apiKeys, openai: 'sk-test-openai-key-123456' }
        }
      },
      {
        callbacks: {
          onChunk: chunk => chunks.push(chunk)
        }
      }
    );

    expect(result.text).toBe('Hello world');
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: undefined,
      totalTokens: 12
    });
    expect(chunks).toEqual(['Hello ', 'world']);
  });

  it('enforces maxResponseChars and throws cleanly', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"1234567890"}\n\n'));
        controller.close();
      }
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    await expect(
      runTurn({
        kind: 'contract_suggestion',
        messages: [{ id: 'm1', role: 'user', content: 'Extract', timestamp: 1 }],
        modelId: 'gpt-6-astra',
        researchMode: 'general',
        maxResponseChars: 5,
        settings: {
          ...DEFAULT_SETTINGS,
          apiKeys: { ...DEFAULT_SETTINGS.apiKeys, openai: 'sk-test-openai-key-123456' }
        }
      })
    ).rejects.toThrow('Response exceeded maximum length');
  });

  it('returns aborted=true when AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')));

    const result = await runTurn(
      {
        kind: 'document_analysis',
        messages: [{ id: 'm1', role: 'user', content: 'Analyze', timestamp: 1 }],
        modelId: 'gpt-6-astra',
        researchMode: 'document_analysis',
        settings: {
          ...DEFAULT_SETTINGS,
          apiKeys: { ...DEFAULT_SETTINGS.apiKeys, openai: 'sk-test-openai-key-123456' }
        }
      },
      { signal: controller.signal }
    );

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });
});
