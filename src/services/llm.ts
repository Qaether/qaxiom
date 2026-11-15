import type { ChatMessage, DocumentChatContext, ResearchMode, UserSettings } from '../types';
import type { ProviderCallbacks } from './providers/gemini';
import type { ContextBundle } from './retrieval/types';
import { DOCUMENT_FILE_CHANGES_INSTRUCTIONS, runTurn } from '../harness/runTurn';

export type { ProviderCallbacks as StreamCallbacks };
export { DOCUMENT_FILE_CHANGES_INSTRUCTIONS };

/**
 * Unified LLM Router (compatibility wrapper around harness runTurn).
 */
export async function sendChatMessage(
  messages: ChatMessage[],
  modelId: string,
  researchMode: string,
  settings: UserSettings,
  callbacks: ProviderCallbacks,
  abortSignal?: AbortSignal,
  contextBundle?: ContextBundle,
  documentContext?: DocumentChatContext
): Promise<void> {
  const kind = researchMode === 'document_analysis' ? 'document_analysis' : 'chat';
  try {
    const result = await runTurn(
      {
        kind,
        messages,
        modelId,
        researchMode: researchMode as ResearchMode | 'document_analysis',
        settings,
        contextBundle,
        documentContext
      },
      {
        signal: abortSignal,
        callbacks: {
          onChunk: chunk => callbacks.onChunk(chunk),
          onReasoningSummary: callbacks.onReasoningSummary
        }
      }
    );
    if (result.aborted) {
      callbacks.onFinish();
      return;
    }
    callbacks.onFinish();
  } catch (error) {
    if (abortSignal?.aborted) {
      callbacks.onFinish();
      return;
    }
    callbacks.onError(error instanceof Error ? error : new Error(String(error)));
  }
}
