import type { ChatMessage, UserSettings } from '../types';
import { AVAILABLE_MODELS, RESEARCH_MODES } from '../constants';
import { streamGemini, type ProviderCallbacks } from './providers/gemini';
import { streamOpenAI } from './providers/openai';
import { streamAnthropic } from './providers/anthropic';
import type { ContextBundle } from './retrieval/types';
import { GRAPH_INSTRUCTIONS, REFERENCE_INSTRUCTIONS, withReferenceContext } from './retrieval/context';
import { assertGraphContextCurrent } from './retrieval/graphContext';
import { assertRagProjectScopeCurrent } from './retrieval/projectScope';

export type { ProviderCallbacks as StreamCallbacks };

/**
 * 연구 AI 통합 라우터 (Unified LLM Router)
 * 선택된 모델의 Provider에 따라 개별 독립 API 모듈로 요청을 라우팅합니다.
 */
export async function sendChatMessage(
  messages: ChatMessage[],
  modelId: string,
  researchMode: string,
  settings: UserSettings,
  callbacks: ProviderCallbacks,
  abortSignal?: AbortSignal,
  contextBundle?: ContextBundle
): Promise<void> {
  const model = AVAILABLE_MODELS.find(m => m.id === modelId) || AVAILABLE_MODELS[0];
  const provider = model.provider;
  const modeInfo = RESEARCH_MODES[researchMode] || RESEARCH_MODES.general;
  if (contextBundle) contextBundle = structuredClone(contextBundle);
  const systemPrompt = modeInfo.systemPrompt + (contextBundle ? REFERENCE_INSTRUCTIONS : '') + (contextBundle?.graph ? GRAPH_INSTRUCTIONS : '');
  let finished = false;
  const guarded = !!(contextBundle?.graph || contextBundle?.assembly?.research || contextBundle?.projectScope);
  const providerCallbacks = guarded ? { ...callbacks, onFinish: () => { finished = true; } } : callbacks;

  try {
    const projectSignature = contextBundle ? await assertRagProjectScopeCurrent(contextBundle) : null;
    if (contextBundle?.graph) await assertGraphContextCurrent(contextBundle);
    if (contextBundle) messages = withReferenceContext(messages, contextBundle);
    switch (provider) {
      case 'gemini': {
        const apiKey = settings.apiKeys.gemini.trim();
        if (!apiKey) {
          throw new Error('Google Gemini API 키가 설정되지 않았습니다. [설정]에서 API 키를 입력해 주세요.');
        }
        await streamGemini(messages, model, systemPrompt, apiKey, settings.temperature, providerCallbacks, abortSignal);
        break;
      }

      case 'openai': {
        const apiKey = settings.apiKeys.openai.trim();
        if (!apiKey) {
          throw new Error('OpenAI API 키가 설정되지 않았습니다. [설정]에서 API 키를 입력해 주세요.');
        }
        await streamOpenAI(messages, model, systemPrompt, apiKey, providerCallbacks, abortSignal);
        break;
      }

      case 'anthropic': {
        const apiKey = settings.apiKeys.anthropic.trim();
        if (!apiKey) {
          throw new Error('Anthropic Claude API 키가 설정되지 않았습니다. [설정]에서 API 키를 입력해 주세요.');
        }
        await streamAnthropic(messages, model, systemPrompt, apiKey, settings.temperature, providerCallbacks, abortSignal);
        break;
      }

      default:
        throw new Error(`지원되지 않는 프로바이더입니다: ${provider}`);
    }
    if (contextBundle && guarded && finished) {
      if (!abortSignal?.aborted) {
        try {
          await assertGraphContextCurrent(contextBundle);
          if (projectSignature !== await assertRagProjectScopeCurrent(contextBundle)) throw new Error('프로젝트/원문이 전송 중 변경되었습니다.');
        } catch (cause) {
          throw new Error(`${cause instanceof Error ? cause.message : String(cause)} 전송 후 검증 실패로 답변은 완료 처리하지 않습니다. 제공사 비용은 미확인입니다.`);
        }
      }
      callbacks.onFinish();
    }
  } catch (error) {
    if (abortSignal?.aborted) {
      callbacks.onFinish();
      return;
    }
    callbacks.onError(error instanceof Error ? error : new Error(String(error)));
  }
}
