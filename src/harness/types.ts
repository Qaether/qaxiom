import type {
  ChatMessage,
  DocumentChatContext,
  ModelOption,
  ResearchMode,
  UserSettings
} from '../types';
import type { ContextBundle } from '../services/retrieval/types';
import type { ProviderUsage, SystemBlock } from '../services/providers/types';
import type { QaxiomDatabase } from '../services/database';
import type { ContextAssemblyPreview } from './contextAssembler';
import type { HarnessToolCall, HarnessToolResult } from './tools';

export type TaskKind = 'chat' | 'document_analysis' | 'contract_suggestion' | 'wiki_curate';

export interface TaskSpec {
  kind: TaskKind;
  defaultTimeoutMs?: number;
  maxResponseChars?: number;
  buildSystemBlocks: (params: {
    researchMode: string;
    modeSystemPrompt: string;
    hasContextBundle: boolean;
    hasGraph: boolean;
    hasDocumentContext: boolean;
  }) => SystemBlock[];
}

export interface TurnRequest {
  kind: TaskKind;
  messages: ChatMessage[];
  modelId: string;
  researchMode: ResearchMode | 'document_analysis';
  settings: UserSettings;
  contextBundle?: ContextBundle;
  documentContext?: DocumentChatContext;
  timeoutMs?: number;
  maxResponseChars?: number;
  enableToolLoop?: boolean;
  maxToolHops?: number;
  toolDatabase?: QaxiomDatabase;
  cliSessionId?: string;
}

export interface TurnCallbacks {
  onChunk?: (chunk: string, accumulated: string) => void;
  onReasoningSummary?: (chunk: string) => void;
  onUsage?: (usage: ProviderUsage) => void;
  onSessionId?: (sessionId: string) => void;
  onToolCall?: (call: HarnessToolCall, result: HarnessToolResult) => void;
}

export interface TurnOptions {
  signal?: AbortSignal;
  callbacks?: TurnCallbacks;
}

export interface TurnResult {
  text: string;
  model: ModelOption;
  durationMs: number;
  aborted: boolean;
  timedOut: boolean;
  usage?: ProviderUsage;
  cliSessionId?: string;
  contextPreview?: ContextAssemblyPreview;
  toolHopsUsed?: number;
}
