import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ModelOption } from '../../types';
import { streamAnthropic } from './anthropic';
import { streamGemini, type ProviderCallbacks } from './gemini';
import { streamOpenAI } from './openai';
import { LIGHT_CHAT_MODELS } from '../chatRouting';

const TEST_MODELS: Record<string, ModelOption> = {
  'gpt-6-astra': {
    id: 'gpt-6-astra',
    name: 'OpenAI GPT-6 Astra',
    provider: 'openai',
    description: 'OpenAI test model',
    status: 'active',
    api: 'responses',
    supportsTemperature: false,
    reasoningEffort: 'medium',
    verifiedAt: '2026-10-03'
  },
  'gpt-6-luna': {
    id: 'gpt-6-luna',
    name: 'OpenAI GPT-6 Luna',
    provider: 'openai',
    description: 'OpenAI test model',
    status: 'active',
    api: 'responses',
    supportsTemperature: false,
    reasoningEffort: 'low',
    verifiedAt: '2026-10-03'
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'anthropic',
    description: 'Anthropic test model',
    status: 'active',
    api: 'messages',
    supportsTemperature: false,
    verifiedAt: '2026-10-03'
  },
  'gemini-3.8-flash': {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    provider: 'gemini',
    description: 'Gemini test model',
    status: 'active',
    api: 'generate-content',
    supportsTemperature: true,
    verifiedAt: '2026-11-14'
  }
};

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: '질문', timestamp: 1 },
  { id: 'a1', role: 'assistant', content: '이전 답변', timestamp: 2 }
];

function responseFromSSE(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    }
  });
  return new Response(body, { status: 200 });
}

function callbacks() {
  return {
    onChunk: vi.fn(),
    onError: vi.fn(),
    onFinish: vi.fn()
  } satisfies ProviderCallbacks;
}

function model(id: string) {
  const found = TEST_MODELS[id];
  if (!found) throw new Error(`Missing test model: ${id}`);
  return found;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider streaming adapters', () => {
  it('omits unsupported reasoning settings for the internal GPT-4o mini route', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseFromSSE('data: {"type":"response.completed"}\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    await streamOpenAI(messages, LIGHT_CHAT_MODELS.openai!, 'system', 'key', callbacks());
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.model).toBe('gpt-4o-mini');
    expect(request).not.toHaveProperty('reasoning');
  });

  it('streams OpenAI Responses deltas and sends a stateless reasoning request', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseFromSSE(
      'data: {"type":"response.output_text.delta","delta":"안"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"녕"}\n\n',
      'data: {"type":"response.completed"}\n\n'
    ));
    vi.stubGlobal('fetch', fetchMock);
    const handlers = callbacks();

    await streamOpenAI(messages, model('gpt-6-astra'), 'system', 'key', handlers);

    expect(handlers.onChunk.mock.calls.flat()).toEqual(['안', '녕']);
    expect(handlers.onFinish).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'gpt-6-astra',
      instructions: 'system',
      stream: true,
      store: false,
      reasoning: { effort: 'medium' },
      input: [
        { role: 'user', content: '질문' },
        { role: 'assistant', content: '이전 답변' }
      ]
    });
  });

  it('keeps OpenAI reasoning summaries separate from the final analysis JSON', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseFromSSE(
      'data: {"type":"response.reasoning_summary_text.delta","delta":"가정 검토 중"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"{\\"findings\\":[]}"}\n\n'
    ));
    vi.stubGlobal('fetch', fetchMock);
    const handlers = { ...callbacks(), onReasoningSummary: vi.fn() };
    await streamOpenAI(messages, model('gpt-6-astra'), 'system', 'key', handlers);
    expect(handlers.onReasoningSummary).toHaveBeenCalledWith('가정 검토 중');
    expect(handlers.onChunk.mock.calls.flat()).toEqual(['{"findings":[]}']);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).reasoning).toEqual({ effort: 'medium', summary: 'auto' });
  });

  it('surfaces typed OpenAI error events without provider details', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(responseFromSSE(
      'data: {"type":"error","message":"rate limited"}\n\n'
    )));

    await expect(
      streamOpenAI(messages, model('gpt-6-astra'), 'system', 'key', callbacks())
    ).rejects.toThrow('OpenAI 스트리밍 처리 중 오류가 발생했습니다.');
  });

  it('does not expose OpenAI HTTP error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'submitted secret text' } }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    )));

    await expect(
      streamOpenAI(messages, model('gpt-6-astra'), 'system', 'key', callbacks())
    ).rejects.toThrow('OpenAI API 요청 실패 (HTTP 429).');
  });

  it('streams Anthropic deltas without an unsupported temperature field', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseFromSSE(
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude"}}\n\n'
    ));
    vi.stubGlobal('fetch', fetchMock);
    const handlers = callbacks();

    await streamAnthropic(messages, model('claude-sonnet-5'), 'system', 'key', 0.7, handlers);

    expect(handlers.onChunk).toHaveBeenCalledWith('Claude');
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('temperature');
  });

  it('keeps Anthropic summarized thinking separate from final text', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseFromSSE(
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"검토 중"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"findings\\":[]}"}}\n\n'
    ));
    vi.stubGlobal('fetch', fetchMock);
    const handlers = { ...callbacks(), onReasoningSummary: vi.fn() };
    await streamAnthropic(messages, model('claude-sonnet-5'), 'system', 'key', 0.7, handlers);
    expect(handlers.onReasoningSummary).toHaveBeenCalledWith('검토 중');
    expect(handlers.onChunk.mock.calls.flat()).toEqual(['{"findings":[]}']);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(request.max_tokens).toBe(16384);
    expect(request).not.toHaveProperty('temperature');
  });

  it('streams Gemini deltas and keeps supported temperature configuration', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseFromSSE(
      'data: {"candidates":[{"content":{"parts":[{"text":"Gemini"}]}}]}'
    ));
    vi.stubGlobal('fetch', fetchMock);
    const handlers = callbacks();

    await streamGemini(messages, model('gemini-3.8-flash'), 'system', 'key', 0.3, handlers);

    expect(handlers.onChunk).toHaveBeenCalledWith('Gemini');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/models/gemini-3.8-flash:streamGenerateContent');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      generationConfig: { temperature: 0.3 }
    });
  });

  it('keeps Gemini thought summaries separate from the final analysis JSON', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseFromSSE(
      'data: {"candidates":[{"content":{"parts":[{"text":"전제 확인 중","thought":true},{"text":"{\\"findings\\":[]}"}]}}]}\n\n'
    ));
    vi.stubGlobal('fetch', fetchMock);
    const handlers = { ...callbacks(), onReasoningSummary: vi.fn() };
    await streamGemini(messages, model('gemini-3.8-flash'), 'system', 'key', 0.3, handlers);
    expect(handlers.onReasoningSummary).toHaveBeenCalledWith('전제 확인 중');
    expect(handlers.onChunk.mock.calls.flat()).toEqual(['{"findings":[]}']);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).generationConfig.thinkingConfig).toEqual({ includeThoughts: true });
  });

  it('rejects non-ASCII or whitespace-containing API keys before fetch and trims valid keys', async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseFromSSE(
      'data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
    ));
    vi.stubGlobal('fetch', fetchMock);
    const handlers = { onChunk: vi.fn(), onError: vi.fn(), onFinish: vi.fn() };

    await expect(
      streamOpenAI(messages, model('gpt-6-luna'), 'system', 'sk-한글키', handlers)
    ).rejects.toThrow('OpenAI API 키에 사용할 수 없는 문자');
    expect(fetchMock).not.toHaveBeenCalled();

    await streamOpenAI(messages, model('gpt-6-luna'), 'system', '  sk-valid-key\n', handlers);
    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-valid-key');
  });

  it('emits Anthropic cache_control for cacheable system blocks and reports usage', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseFromSSE(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":80,"cache_creation_input_tokens":20}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":15}}\n\n'
    ));
    vi.stubGlobal('fetch', fetchMock);
    const onUsage = vi.fn();
    const handlers = { ...callbacks(), onUsage };

    await streamAnthropic(
      messages,
      model('claude-sonnet-5'),
      [
        { text: 'static prefix', cacheable: true },
        { text: 'dynamic suffix', cacheable: false }
      ],
      'key',
      0.5,
      handlers
    );

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.system).toEqual([
      { type: 'text', text: 'static prefix', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'dynamic suffix' }
    ]);
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 100,
      outputTokens: 15,
      cacheReadTokens: 80,
      cacheWriteTokens: 20,
      totalTokens: 215
    });
  });

  it('flattens SystemBlock[] for OpenAI and reports usage from response.completed', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseFromSSE(
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":50,"output_tokens":12,"total_tokens":62,"input_tokens_details":{"cached_tokens":30}}}}\n\n'
    ));
    vi.stubGlobal('fetch', fetchMock);
    const onUsage = vi.fn();
    const handlers = { ...callbacks(), onUsage };

    await streamOpenAI(
      messages,
      model('gpt-6-astra'),
      [{ text: 'part A', cacheable: true }, { text: 'part B' }],
      'key',
      handlers
    );

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.instructions).toBe('part Apart B');
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 50,
      outputTokens: 12,
      cacheReadTokens: 30,
      totalTokens: 62
    });
  });

  it('sends systemInstruction.parts for Gemini and reports usageMetadata', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(responseFromSSE(
      'data: {"candidates":[{"content":{"parts":[{"text":"gem"}]}}],"usageMetadata":{"promptTokenCount":40,"candidatesTokenCount":10,"cachedContentTokenCount":25,"totalTokenCount":50}}\n\n'
    ));
    vi.stubGlobal('fetch', fetchMock);
    const onUsage = vi.fn();
    const handlers = { ...callbacks(), onUsage };

    await streamGemini(
      messages,
      model('gemini-3.8-flash'),
      [{ text: 'prefix', cacheable: true }, { text: 'suffix' }],
      'key',
      0.3,
      handlers
    );

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.systemInstruction.parts).toEqual([{ text: 'prefix' }, { text: 'suffix' }]);
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 40,
      outputTokens: 10,
      cacheReadTokens: 25,
      totalTokens: 50
    });
  });
});
