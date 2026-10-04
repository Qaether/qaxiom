export type ResearchMode = 
  | 'general' 
  | 'peer_review' 
  | 'proofreader' 
  | 'math_proof' 
  | 'literature_synth';

export interface ResearchModeInfo {
  id: ResearchMode;
  name: string;
  badge: string;
  description: string;
  systemPrompt: string;
}

export type LLMProvider = 'gemini' | 'openai' | 'anthropic' | 'custom';

export type ModelStatus = 'active' | 'preview' | 'deprecated' | 'disabled';

export type ModelApi = 'responses' | 'messages' | 'generate-content';

export type MessageStatus = 'streaming' | 'complete' | 'stopped' | 'error';

export interface ModelOption {
  id: string;
  name: string;
  provider: LLMProvider;
  description: string;
  status: ModelStatus;
  api: ModelApi;
  supportsTemperature: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  verifiedAt: string;
  recommended?: boolean;
  contextWindowTokens?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  model?: string;
  researchMode?: ResearchMode;
  isStreaming?: boolean;
  status?: MessageStatus;
  errorMessage?: string;
  contextBundle?: ContextBundle;
  documentContext?: DocumentChatContext;
}

export interface DocumentChatContext {
  documentId: string;
  versionId: string | null;
  title: string;
  markdown: string;
  contentHash: string;
  contract: import('./services/theory/types').ResearchContract;
  capturedAt: number;
}

export interface ChatSession {
  id: string;
  documentId?: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  researchMode: ResearchMode;
  selectedModel: string;
}

export interface UserSettings {
  apiKeys: {
    gemini: string;
    openai: string;
    anthropic: string;
    customUrl: string;
    customKey: string;
  };
  defaultModel: string;
  defaultMode: ResearchMode;
  streamResponses: boolean;
  temperature: number;
}

export interface WikiPage {
  id: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  backlinks: string[];
  createdAt: number;
  updatedAt: number;
}
import type { ContextBundle } from './services/retrieval/types';
