import { streamAnthropic } from './anthropic';
import { streamGemini } from './gemini';
import { streamOpenAI } from './openai';
import type { NormalizedProviderRequest, ProviderUsage } from './types';

/**
 * Normalized provider invocation router.
 * Dispatches a unified request (including cacheable system blocks) to the configured provider
 * and returns normalized token/cache usage if reported by the stream.
 */
export async function invokeProvider(request: NormalizedProviderRequest): Promise<ProviderUsage | undefined> {
  const { model, messages, system, apiKey, temperature, callbacks, signal } = request;
  let capturedUsage: ProviderUsage | undefined;

  const wrappedCallbacks = {
    ...callbacks,
    onUsage: (usage: ProviderUsage) => {
      capturedUsage = usage;
      callbacks.onUsage?.(usage);
    }
  };

  switch (model.provider) {
    case 'gemini':
      await streamGemini(messages, model, system, apiKey, temperature, wrappedCallbacks, signal);
      return capturedUsage;
    case 'openai':
      await streamOpenAI(messages, model, system, apiKey, wrappedCallbacks, signal);
      return capturedUsage;
    case 'anthropic':
      await streamAnthropic(messages, model, system, apiKey, temperature, wrappedCallbacks, signal);
      return capturedUsage;
    default:
      throw new Error(`지원되지 않는 프로바이더입니다: ${model.provider}`);
  }
}
