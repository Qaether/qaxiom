import { describe, expect, it } from 'vitest';
import { AVAILABLE_MODELS } from '../../constants';
import type { ChatMessage } from '../../types';
import { requestEmbeddings } from '../retrieval/embeddings';
import type { EmbeddingSpace } from '../retrieval/embeddingTypes';
import { streamOpenAI } from './openai';

// Opt-in only. Use fixed synthetic input; never print the key or provider output.
const live = process.env.QAXIOM_LIVE_OPENAI === '1' ? describe : describe.skip;

live('OpenAI live smoke', () => {
  const apiKey = process.env.OPENAI_API_KEY;

  it('streams a short synthetic Responses API answer', async () => {
    expect(apiKey, 'OPENAI_API_KEY must be set for live smoke').toBeTruthy();
    const model = AVAILABLE_MODELS.find(candidate => candidate.id === 'gpt-6-astra');
    expect(model).toBeDefined();
    const messages: ChatMessage[] = [{ id: 'synthetic', role: 'user', content: 'Reply with only OK.', timestamp: 0 }];
    let output = '';
    let finished = false;
    await streamOpenAI(messages, model!, 'This is a connectivity test. Reply with only OK.', apiKey!, {
      onChunk: chunk => { output += chunk; },
      onFinish: () => { finished = true; },
      onError: () => {}
    }, AbortSignal.timeout(60000));
    expect(finished).toBe(true);
    expect(output.trim().length).toBeGreaterThan(0);
  }, 65000);

  it('accepts a 512-dimensional synthetic embedding', async () => {
    expect(apiKey, 'OPENAI_API_KEY must be set for live smoke').toBeTruthy();
    const space: EmbeddingSpace = {
      id: 'synthetic', provider: 'openai', model: 'text-embedding-3-small', dimensions: 512,
      adapterVersion: 'openai-embedding-v1', providerRevision: null, createdAt: 0,
      runId: null, deadlineAt: null
    };
    const result = await requestEmbeddings(space, ['Synthetic research reference for connectivity testing.'], apiKey!, AbortSignal.timeout(30000));
    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0]).toHaveLength(512);
    expect(result.promptTokens).toBeGreaterThan(0);
  }, 35000);
});
