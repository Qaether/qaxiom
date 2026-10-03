import type { ChatMessage, ModelOption } from '../../types';
import type { ProviderCallbacks } from './gemini';
import { consumeJsonSSE } from '../sse';

interface AnthropicStreamEvent {
  type?: string;
  delta?: { text?: string };
  error?: { message?: string };
}

/**
 * Anthropic Claude 직접 스트리밍 호출 모듈
 * Claude Messages API 스트리밍을 처리합니다.
 */
export async function streamAnthropic(
  messages: ChatMessage[],
  model: ModelOption,
  systemPrompt: string,
  apiKey: string,
  temperature: number,
  callbacks: ProviderCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const anthropicMessages = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  const requestBody: Record<string, unknown> = {
    model: model.id,
    system: systemPrompt,
    messages: anthropicMessages,
    max_tokens: 4096,
    stream: true
  };

  if (model.supportsTemperature) {
    requestBody.temperature = temperature;
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
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

  await consumeJsonSSE(response.body, payload => {
    const event = payload as AnthropicStreamEvent;
    if (event.type === 'content_block_delta' && event.delta?.text) {
      callbacks.onChunk(event.delta.text);
    } else if (event.type === 'error') {
      throw new Error(event.error?.message || 'Anthropic 스트리밍 처리 중 오류가 발생했습니다.');
    }
  });

  callbacks.onFinish();
}
