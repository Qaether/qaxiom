import type { ChatMessage, ModelOption } from '../../types';

export interface SystemBlock {
  text: string;
  cacheable?: boolean;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export interface ProviderCallbacks {
  onChunk: (chunk: string) => void;
  onReasoningSummary?: (chunk: string) => void;
  onUsage?: (usage: ProviderUsage) => void;
  onError: (error: Error) => void;
  onFinish: () => void;
}

export interface NormalizedProviderRequest {
  model: ModelOption;
  messages: ChatMessage[];
  system: string | SystemBlock[];
  apiKey: string;
  temperature: number;
  callbacks: ProviderCallbacks;
  signal?: AbortSignal;
}

export function flattenSystemBlocks(system: string | SystemBlock[]): string {
  if (typeof system === 'string') return system;
  return system.map(block => block.text).join('');
}
