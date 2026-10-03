import type { ChatMessage, ModelOption } from '../../types';
import { consumeJsonSSE } from '../sse';

interface GeminiStreamEvent {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  error?: { message?: string };
}

export interface ProviderCallbacks {
  onChunk: (chunk: string) => void;
  onError: (error: Error) => void;
  onFinish: () => void;
}

/**
 * Google Gemini 직접 스트리밍 호출 모듈
 * 브라우저 CORS를 기본 지원하며 Server-Sent Events (SSE)로 스트리밍합니다.
 */
export async function streamGemini(
  messages: ChatMessage[],
  model: ModelOption,
  systemPrompt: string,
  apiKey: string,
  temperature: number,
  callbacks: ProviderCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const contents = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }]
    }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const requestBody = {
    contents,
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    ...(model.supportsTemperature
      ? { generationConfig: { temperature } }
      : {})
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal
  });

  if (!response.ok) {
    const errorJson = await response.json().catch(() => ({}));
    const rawMessage = errorJson.error?.message || `상태 코드 ${response.status}`;
    
    if (rawMessage.includes('API_KEY_INVALID') || rawMessage.includes('API key not valid')) {
      throw new Error('Google Gemini API 키가 유효하지 않습니다. Google AI Studio에서 올바른 API 키를 복사하여 [설정]에 입력해 주세요.');
    }
    if (rawMessage.includes('models/') && rawMessage.includes('not found')) {
      throw new Error(`모델 '${model.id}'을(를) 찾을 수 없습니다. 모델 상태를 확인하거나 다른 활성 Gemini 모델을 선택해 주세요.`);
    }
    if (rawMessage.includes('RESOURCE_EXHAUSTED')) {
      throw new Error('Google API 호출 한도(Quota)를 초과했습니다. 잠시 후 다시 시도해 주세요.');
    }
    throw new Error(`Gemini API 오류: ${rawMessage}`);
  }

  if (!response.body) throw new Error('스트리밍 응답 스트림을 읽을 수 없습니다.');

  await consumeJsonSSE(response.body, payload => {
    const event = payload as GeminiStreamEvent;
    if (event.error?.message) {
      throw new Error(`Gemini 스트리밍 오류: ${event.error.message}`);
    }
    const text = event.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) callbacks.onChunk(text);
  });

  callbacks.onFinish();
}
