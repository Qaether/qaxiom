import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyChatRoute, internalLightModel } from './chatRouting';

afterEach(() => vi.unstubAllGlobals());

describe('provider-local chat routing', () => {
  it('does not spend a classifier request on an obvious greeting', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(await classifyChatRoute('하이', 'openai', 'key')).toBe('light');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['openai', 'gpt-4o-mini', { choices: [{ message: { content: 'light' } }] }],
    ['gemini', 'gemini-3.5-flash-lite', { candidates: [{ content: { parts: [{ text: 'light' }] } }] }],
    ['anthropic', 'claude-haiku-4-5-20251001', { content: [{ text: 'light' }] }]
  ] as const)('uses %s only to classify the question, without document text', async (provider, modelId, body) => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => body })); vi.stubGlobal('fetch', fetchMock);
    expect(await classifyChatRoute('오늘 기분 어때?', provider, 'key')).toBe('light');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(provider === 'anthropic' ? '/messages' : provider === 'openai' ? '/chat/completions' : modelId);
    expect(`${url} ${JSON.stringify(init.body)}`).toContain(modelId);
    expect(JSON.stringify(init.body)).toContain('오늘 기분 어때?');
    expect(JSON.stringify(init.body)).not.toContain('research_document');
    expect(internalLightModel(modelId)?.provider).toBe(provider);
  });

  it('fails closed to research on classifier errors or ambiguous output', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    expect(await classifyChatRoute('이거 어떻게 생각해?', 'openai', 'key')).toBe('research');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'maybe' } }] }) })));
    expect(await classifyChatRoute('이거 어떻게 생각해?', 'openai', 'key')).toBe('research');
    expect(await classifyChatRoute('연구 노트 분석해 줘', 'openai', '')).toBe('research');
  });
});
