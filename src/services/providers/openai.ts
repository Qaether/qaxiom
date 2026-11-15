import type { ChatMessage, ModelOption } from '../../types';
import { consumeJsonSSE } from '../sse';
import { validateApiKeyFormat } from './apiKey';
import { flattenSystemBlocks, type ProviderCallbacks, type ProviderUsage, type SystemBlock } from './types';

interface OpenAIStreamEvent {
  type?: string;
  delta?: string;
  response?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
  };
}

/**
 * OpenAI 직접 스트리밍 호출 모듈
 * Responses API의 typed SSE 이벤트를 처리합니다.
 */
export async function streamOpenAI(
  messages: ChatMessage[],
  model: ModelOption,
  systemPrompt: string | SystemBlock[],
  apiKey: string,
  callbacks: ProviderCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const input = messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => ({ role: message.role, content: message.content }));

  const requestPayload = {
    model: model.id,
    instructions: flattenSystemBlocks(systemPrompt),
    input,
    stream: true,
    store: false,
    ...(model.reasoningEffort ? { reasoning: {
      effort: model.reasoningEffort,
      ...(callbacks.onReasoningSummary ? { summary: 'auto' } : {})
    } } : {})
  };

  const cleanKey = validateApiKeyFormat(apiKey, 'OpenAI');

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cleanKey}`
    },
    body: JSON.stringify(requestPayload),
    signal
  });

  if (!response.ok) {
    // Provider error bodies may include submitted text or other sensitive details.
    throw new Error(`OpenAI API 요청 실패 (HTTP ${response.status}).`);
  }

  if (!response.body) throw new Error('응답 스트림을 읽을 수 없습니다.');

  let latestUsage: ProviderUsage | undefined;

  await consumeJsonSSE(response.body, payload => {
    const event = payload as OpenAIStreamEvent;
    if (event.type === 'response.output_text.delta' && event.delta) {
      callbacks.onChunk(event.delta);
    } else if (event.type === 'response.reasoning_summary_text.delta' && event.delta) {
      callbacks.onReasoningSummary?.(event.delta);
    } else if (event.type === 'response.completed' && event.response?.usage) {
      const u = event.response.usage;
      latestUsage = {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.input_tokens_details?.cached_tokens,
        totalTokens: u.total_tokens
      };
    } else if (event.type === 'error') {
      throw new Error('OpenAI 스트리밍 처리 중 오류가 발생했습니다.');
    } else if (event.type === 'response.failed') {
      throw new Error('OpenAI 응답 생성에 실패했습니다.');
    }
  });

  if (latestUsage) callbacks.onUsage?.(latestUsage);
  callbacks.onFinish();
}
