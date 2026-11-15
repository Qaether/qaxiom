import type { ChatMessage, ModelOption } from '../../types';
import { consumeJsonSSE } from '../sse';
import { validateApiKeyFormat } from './apiKey';
import type { ProviderCallbacks, ProviderUsage, SystemBlock } from './types';

interface AnthropicStreamEvent {
  type?: string;
  delta?: { type?: string; text?: string; thinking?: string };
  message?: {
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  usage?: {
    output_tokens?: number;
  };
  error?: { message?: string };
}

/**
 * Anthropic Claude 직접 스트리밍 호출 모듈
 * Claude Messages API 스트리밍 및 프롬프트 캐싱 블록을 처리합니다.
 */
export async function streamAnthropic(
  messages: ChatMessage[],
  model: ModelOption,
  systemPrompt: string | SystemBlock[],
  apiKey: string,
  temperature: number,
  callbacks: ProviderCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const anthropicMessages = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  const systemPayload = typeof systemPrompt === 'string'
    ? systemPrompt
    : systemPrompt
      .filter(block => block.text.length > 0)
      .map(block => ({
        type: 'text' as const,
        text: block.text,
        ...(block.cacheable ? { cache_control: { type: 'ephemeral' as const } } : {})
      }));

  const requestBody: Record<string, unknown> = {
    model: model.id,
    system: systemPayload,
    messages: anthropicMessages,
    max_tokens: callbacks.onReasoningSummary ? 16384 : 4096,
    stream: true
  };

  if (callbacks.onReasoningSummary) {
    requestBody.thinking = { type: 'adaptive', display: 'summarized' };
  }

  if (model.supportsTemperature && !callbacks.onReasoningSummary) {
    requestBody.temperature = temperature;
  }

  const cleanKey = validateApiKeyFormat(apiKey, 'Anthropic');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cleanKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(requestBody),
    signal
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic API 오류 (상태 코드: ${response.status})`);
  }

  if (!response.body) throw new Error('응답 스트림을 읽을 수 없습니다.');

  const usage: ProviderUsage = {};
  let hasUsage = false;

  await consumeJsonSSE(response.body, payload => {
    const event = payload as AnthropicStreamEvent;
    if (event.type === 'message_start' && event.message?.usage) {
      const u = event.message.usage;
      usage.inputTokens = u.input_tokens;
      usage.cacheReadTokens = u.cache_read_input_tokens;
      usage.cacheWriteTokens = u.cache_creation_input_tokens;
      hasUsage = true;
    } else if (event.type === 'message_delta' && event.usage?.output_tokens !== undefined) {
      usage.outputTokens = event.usage.output_tokens;
      hasUsage = true;
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && event.delta.thinking) {
      callbacks.onReasoningSummary?.(event.delta.thinking);
    } else if (event.type === 'content_block_delta' && event.delta?.text) {
      callbacks.onChunk(event.delta.text);
    } else if (event.type === 'error') {
      throw new Error(event.error?.message || 'Anthropic 스트리밍 처리 중 오류가 발생했습니다.');
    }
  });

  if (hasUsage) {
    if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
      usage.totalTokens = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    }
    callbacks.onUsage?.(usage);
  }
  callbacks.onFinish();
}
