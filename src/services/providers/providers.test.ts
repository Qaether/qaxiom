import { afterEach, describe, expect, it, vi } from 'vitest';
import { AVAILABLE_MODELS } from '../../constants';
import type { ChatMessage } from '../../types';
import { streamAnthropic } from './anthropic';
import { streamGemini, type ProviderCallbacks } from './gemini';
import { streamOpenAI } from './openai';
import { LIGHT_CHAT_MODELS } from '../chatRouting';

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
  const found = AVAILABLE_MODELS.find(candidate => candidate.id === id);
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
});
