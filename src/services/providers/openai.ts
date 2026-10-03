import type { ChatMessage, ModelOption } from '../../types';
import type { ProviderCallbacks } from './gemini';
import { consumeJsonSSE } from '../sse';

interface OpenAIStreamEvent {
  type?: string;
  delta?: string;
}

/**
 * OpenAI 직접 스트리밍 호출 모듈
 * Responses API의 typed SSE 이벤트를 처리합니다.
 */
export async function streamOpenAI(
  messages: ChatMessage[],
  model: ModelOption,
  systemPrompt: string,
  apiKey: string,
  callbacks: ProviderCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const input = messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => ({ role: message.role, content: message.content }));

  const requestPayload = {
    model: model.id,
    instructions: systemPrompt,
    input,
    stream: true,
    store: false,
    reasoning: {
      effort: model.reasoningEffort || 'medium'
    }
  };

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestPayload),
    signal
  });

  if (!response.ok) {
    // Provider error bodies may include submitted text or other sensitive details.
    throw new Error(`OpenAI API 요청 실패 (HTTP ${response.status}).`);
  }

  if (!response.body) throw new Error('응답 스트림을 읽을 수 없습니다.');

  await consumeJsonSSE(response.body, payload => {
    const event = payload as OpenAIStreamEvent;
    if (event.type === 'response.output_text.delta' && event.delta) {
      callbacks.onChunk(event.delta);
    } else if (event.type === 'error') {
      throw new Error('OpenAI 스트리밍 처리 중 오류가 발생했습니다.');
    } else if (event.type === 'response.failed') {
      throw new Error('OpenAI 응답 생성에 실패했습니다.');
    }
  });

  callbacks.onFinish();
}
