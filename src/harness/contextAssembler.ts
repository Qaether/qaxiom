import type { ChatMessage, DocumentChatContext } from '../types';
import type { SystemBlock } from '../services/providers/types';
import type { ContextBundle } from '../services/retrieval/types';
import { GRAPH_INSTRUCTIONS, REFERENCE_INSTRUCTIONS } from '../services/retrieval/context';

export interface ContextBudget {
  maxInputChars: number;
  fullDocumentThresholdChars: number;
  historyBudgetChars: number;
}

export interface ContextAssemblyPreview {
  mode: 'full_document' | 'retrieval_chunks' | 'chat_only';
  estimatedInputTokens: number;
  deduplicatedTurns: number;
  trimmedMessages: number;
  systemBlockCount: number;
  cacheableBlockCount: number;
}

export interface AssembledTurnContext {
  systemBlocks: SystemBlock[];
  messages: ChatMessage[];
  preview: ContextAssemblyPreview;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3);
}

export function getModelContextBudget(modelId: string): ContextBudget {
  const lower = modelId.toLowerCase();
  if (lower.includes('nano') || lower.includes('flash') || lower.includes('haiku')) {
    return {
      maxInputChars: 180_000,
      fullDocumentThresholdChars: 48_000,
      historyBudgetChars: 60_000
    };
  }
  if (lower.includes('gemini')) {
    return {
      maxInputChars: 600_000,
      fullDocumentThresholdChars: 160_000,
      historyBudgetChars: 200_000
    };
  }
  return {
    maxInputChars: 400_000,
    fullDocumentThresholdChars: 100_000,
    historyBudgetChars: 140_000
  };
}

/**
 * Deduplicates repeated untrusted <qaxiom_research_document> or <qaxiom_reference_data>
 * snapshots in earlier turns when the latest turn carries an identical payload,
 * replacing only older duplicates with a compact hash reference.
 */
export function deduplicatePriorSnapshots(messages: ChatMessage[]): {
  messages: ChatMessage[];
  deduplicatedCount: number;
} {
  if (messages.length <= 1) {
    return { messages, deduplicatedCount: 0 };
  }

  let deduplicatedCount = 0;
  const seenDocHashes = new Set<string>();
  const result = messages.map(msg => ({ ...msg }));

  // Scan from newest to oldest so the latest turn always keeps full text.
  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.role !== 'user') continue;

    let content = msg.content;
    const docMatch = content.match(/<qaxiom_research_document[^>]*contentHash="([^"]+)"[^>]*>[\s\S]*?<\/qaxiom_research_document>/);
    if (docMatch) {
      const hash = docMatch[1];
      if (seenDocHashes.has(hash)) {
        content = content.replace(
          docMatch[0],
          `<qaxiom_research_document_ref contentHash="${hash}" note="Identical research note snapshot provided in a later turn." />`
        );
        deduplicatedCount++;
      } else {
        seenDocHashes.add(hash);
      }
    }
    msg.content = content;
  }

  return { messages: result, deduplicatedCount };
}

export function trimHistoryToBudget(
  messages: ChatMessage[],
  historyBudgetChars: number
): { messages: ChatMessage[]; trimmedCount: number } {
  if (messages.length <= 1) {
    return { messages, trimmedCount: 0 };
  }

  let totalChars = 0;
  const kept: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const len = msg.content.length;
    if (kept.length > 0 && totalChars + len > historyBudgetChars) {
      break;
    }
    kept.unshift(msg);
    totalChars += len;
  }

  return {
    messages: kept,
    trimmedCount: messages.length - kept.length
  };
}

export function buildLayeredSystemBlocks(params: {
  basePrompt: string;
  fileChangesInstructions?: string;
  contextBundle?: ContextBundle;
  documentContext?: DocumentChatContext;
}): SystemBlock[] {
  const blocks: SystemBlock[] = [{ text: params.basePrompt, cacheable: true }];
  if (params.contextBundle) {
    blocks.push({ text: REFERENCE_INSTRUCTIONS, cacheable: true });
  }
  if (params.contextBundle?.graph) {
    blocks.push({ text: GRAPH_INSTRUCTIONS, cacheable: true });
  }
  if (params.documentContext && params.fileChangesInstructions) {
    blocks.push({ text: params.fileChangesInstructions, cacheable: true });
  }
  if (params.documentContext) {
    const contract = params.documentContext.contract;
    const nonEmptyContract = Object.entries(contract)
      .filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
      .map(([k, v]) => `- ${k}: ${v.trim()}`)
      .join('\n');
    if (nonEmptyContract) {
      blocks.push({
        text: `\n[ResearchContract Metadata — "${params.documentContext.title}"]\n${nonEmptyContract}`,
        cacheable: true
      });
    }
  }
  return blocks;
}

export function assembleTurnContext(params: {
  modelId: string;
  basePrompt: string;
  fileChangesInstructions?: string;
  messages: ChatMessage[];
  contextBundle?: ContextBundle;
  documentContext?: DocumentChatContext;
}): AssembledTurnContext {
  const budget = getModelContextBudget(params.modelId);
  const systemBlocks = buildLayeredSystemBlocks({
    basePrompt: params.basePrompt,
    fileChangesInstructions: params.fileChangesInstructions,
    contextBundle: params.contextBundle,
    documentContext: params.documentContext
  });

  const { messages: deduped, deduplicatedCount } = deduplicatePriorSnapshots(params.messages);
  const { messages: trimmed, trimmedCount } = trimHistoryToBudget(deduped, budget.historyBudgetChars);

  const totalChars =
    systemBlocks.reduce((sum, b) => sum + b.text.length, 0) +
    trimmed.reduce((sum, m) => sum + m.content.length, 0);

  const docLen = params.documentContext?.markdown.length ?? 0;
  const mode: ContextAssemblyPreview['mode'] = params.contextBundle
    ? 'retrieval_chunks'
    : params.documentContext && docLen <= budget.fullDocumentThresholdChars
      ? 'full_document'
      : params.documentContext
        ? 'retrieval_chunks'
        : 'chat_only';

  return {
    systemBlocks,
    messages: trimmed,
    preview: {
      mode,
      estimatedInputTokens: Math.ceil(totalChars / 3),
      deduplicatedTurns: deduplicatedCount,
      trimmedMessages: trimmedCount,
      systemBlockCount: systemBlocks.length,
      cacheableBlockCount: systemBlocks.filter(b => b.cacheable).length
    }
  };
}
