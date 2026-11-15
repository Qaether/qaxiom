import { describe, expect, it } from 'vitest';
import type { ChatMessage, DocumentChatContext } from '../types';
import { EMPTY_CONTRACT } from '../services/theory/types';
import {
  assembleTurnContext,
  deduplicatePriorSnapshots,
  getModelContextBudget,
  trimHistoryToBudget
} from './contextAssembler';

const sampleDocContext: DocumentChatContext = {
  documentId: 'doc-1',
  versionId: 'v1',
  title: 'Gauge Field Draft',
  markdown: '# Section 1\nLet $A_\\mu$ be a connection.',
  contentHash: 'hash-abc123',
  contract: {
    ...EMPTY_CONTRACT,
    definitions: 'A_mu is a U(1) gauge connection.',
    assumptions: 'Smooth 4D Lorentzian manifold.'
  },
  capturedAt: 100
};

describe('contextAssembler', () => {
  it('deduplicates older identical research document snapshots while keeping latest full text', () => {
    const docTag = '<qaxiom_research_document contentHash="hash-abc123">\n# Body\n</qaxiom_research_document>';
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: `First question\n${docTag}`, timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'First answer', timestamp: 2 },
      { id: 'u2', role: 'user', content: `Follow-up question\n${docTag}`, timestamp: 3 }
    ];

    const { messages: deduped, deduplicatedCount } = deduplicatePriorSnapshots(messages);
    expect(deduplicatedCount).toBe(1);
    expect(deduped[0].content).toContain('<qaxiom_research_document_ref contentHash="hash-abc123"');
    expect(deduped[0].content).not.toContain('# Body');
    expect(deduped[2].content).toContain('# Body');
  });

  it('trims oldest messages first when exceeding history budget while preserving latest turn', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'a'.repeat(500), timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'b'.repeat(500), timestamp: 2 },
      { id: 'u2', role: 'user', content: 'latest question', timestamp: 3 }
    ];

    const { messages: trimmed, trimmedCount } = trimHistoryToBudget(messages, 600);
    expect(trimmedCount).toBe(1);
    expect(trimmed.map(m => m.id)).toEqual(['a1', 'u2']);
  });

  it('builds layered cacheable system blocks with ResearchContract metadata and preview', () => {
    const assembled = assembleTurnContext({
      modelId: 'claude-sonnet-5',
      basePrompt: 'Base prompt',
      fileChangesInstructions: 'File changes prompt',
      messages: [{ id: 'u1', role: 'user', content: 'Check assumptions', timestamp: 1 }],
      documentContext: sampleDocContext
    });

    expect(assembled.systemBlocks.every(b => b.cacheable)).toBe(true);
    expect(assembled.systemBlocks.some(b => b.text.includes('ResearchContract Metadata'))).toBe(true);
    expect(assembled.systemBlocks.some(b => b.text.includes('Smooth 4D Lorentzian manifold'))).toBe(true);
    expect(assembled.preview.mode).toBe('full_document');
    expect(assembled.preview.cacheableBlockCount).toBe(assembled.systemBlocks.length);
  });

  it('uses larger context budget for Gemini models than nano/flash models', () => {
    const gemini = getModelContextBudget('gemini-3.8-pro');
    const nano = getModelContextBudget('gpt-6-nano');
    expect(gemini.fullDocumentThresholdChars).toBeGreaterThan(nano.fullDocumentThresholdChars);
    expect(gemini.historyBudgetChars).toBeGreaterThan(nano.historyBudgetChars);
  });
});
