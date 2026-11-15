import { qaxiomDatabase, type QaxiomDatabase } from '../services/database';
import type { DocumentChatContext } from '../types';
import type { DocumentBlock } from '../services/theory/types';

export type HarnessToolName =
  | 'get_block'
  | 'get_definition'
  | 'search_selected_references'
  | 'list_wiki_index'
  | 'get_wiki_links'
  | 'propose_patch';

export interface HarnessToolCall {
  name: HarnessToolName;
  arguments: Record<string, unknown>;
}

export interface HarnessToolResult {
  toolName: HarnessToolName;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolExecutionScope {
  approvedSourceIds: string[];
  documentContext?: DocumentChatContext;
  blocks?: DocumentBlock[];
  database?: QaxiomDatabase;
}

export interface PatchHunkProposal {
  targetText: string;
  replacementText: string;
  rationale?: string;
}

export const MAX_TOOL_HOPS = 3;

export function applyPatchHunks(
  baseMarkdown: string,
  hunks: PatchHunkProposal[]
): { appliedMarkdown: string; appliedCount: number; unmatchedHunks: number } {
  let current = baseMarkdown;
  let appliedCount = 0;
  let unmatchedHunks = 0;

  for (const hunk of hunks) {
    if (!hunk.targetText) {
      unmatchedHunks++;
      continue;
    }
    const idx = current.indexOf(hunk.targetText);
    if (idx === -1) {
      unmatchedHunks++;
      continue;
    }
    current =
      current.slice(0, idx) +
      hunk.replacementText +
      current.slice(idx + hunk.targetText.length);
    appliedCount++;
  }

  return { appliedMarkdown: current, appliedCount, unmatchedHunks };
}

export function parseToolCallBlocks(text: string): HarnessToolCall[] {
  const calls: HarnessToolCall[] = [];
  const regex = /```qaxiom_tool\r?\n([\s\S]*?)\r?\n```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as { name?: string; arguments?: Record<string, unknown> };
      if (parsed && typeof parsed.name === 'string') {
        calls.push({
          name: parsed.name as HarnessToolName,
          arguments: parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {}
        });
      }
    } catch {
      // Ignore malformed tool JSON blocks
    }
  }
  return calls;
}

export async function executeLocalToolCall(
  call: HarnessToolCall,
  scope: ToolExecutionScope
): Promise<HarnessToolResult> {
  const db = scope.database ?? qaxiomDatabase;
  const approvedSet = new Set(scope.approvedSourceIds);

  switch (call.name) {
    case 'get_block': {
      const blockId = typeof call.arguments.blockId === 'string' ? call.arguments.blockId : '';
      const query = typeof call.arguments.query === 'string' ? call.arguments.query.toLowerCase() : '';
      const blocks = scope.blocks ?? [];
      if (blockId) {
        const found = blocks.find(b => b.id === blockId);
        return found
          ? { toolName: call.name, ok: true, data: { id: found.id, kind: found.kind, position: found.position, text: found.text, contentHash: found.contentHash } }
          : { toolName: call.name, ok: false, error: `Block ${blockId} not found in active document.` };
      }
      if (query) {
        const matches = blocks
          .filter(b => b.text.toLowerCase().includes(query))
          .slice(0, 5)
          .map(b => ({ id: b.id, kind: b.kind, position: b.position, text: b.text, contentHash: b.contentHash }));
        return { toolName: call.name, ok: true, data: matches };
      }
      if (scope.documentContext) {
        return {
          toolName: call.name,
          ok: true,
          data: {
            documentId: scope.documentContext.documentId,
            title: scope.documentContext.title,
            excerpt: scope.documentContext.markdown.slice(0, 2000)
          }
        };
      }
      return { toolName: call.name, ok: false, error: 'No active document context available.' };
    }

    case 'get_definition': {
      const symbol = typeof call.arguments.symbol === 'string' ? call.arguments.symbol.trim().toLowerCase() : '';
      if (!scope.documentContext) {
        return { toolName: call.name, ok: false, error: 'No active document context.' };
      }
      const definitions = scope.documentContext.contract.definitions || '';
      const lines = definitions
        .split('\n')
        .filter(line => !symbol || line.toLowerCase().includes(symbol));
      return {
        toolName: call.name,
        ok: true,
        data: {
          definitions: lines.join('\n'),
          assumptions: scope.documentContext.contract.assumptions || ''
        }
      };
    }

    case 'search_selected_references': {
      const query = typeof call.arguments.query === 'string' ? call.arguments.query.trim().toLowerCase() : '';
      const requestedSourceIds = Array.isArray(call.arguments.sourceIds)
        ? call.arguments.sourceIds.filter((id): id is string => typeof id === 'string')
        : scope.approvedSourceIds;

      for (const sourceId of requestedSourceIds) {
        if (!approvedSet.has(sourceId)) {
          return {
            toolName: call.name,
            ok: false,
            error: `Source "${sourceId}" is not approved for this turn.`
          };
        }
      }

      if (requestedSourceIds.length === 0) {
        return { toolName: call.name, ok: true, data: [] };
      }

      const spans = await db.reference_spans.where('sourceId').anyOf(requestedSourceIds).toArray();
      const hits = spans
        .filter(span => !query || span.text.toLowerCase().includes(query))
        .slice(0, 8)
        .map(span => ({
          spanId: span.id,
          sourceId: span.sourceId,
          contentHash: span.contentHash,
          text: span.text.slice(0, 600)
        }));
      return { toolName: call.name, ok: true, data: hits };
    }

    case 'list_wiki_index': {
      const filter = typeof call.arguments.query === 'string' ? call.arguments.query.trim().toLowerCase() : '';
      const pages = await db.wiki_pages.toArray();
      const filtered = pages
        .filter(p => !filter || p.title.toLowerCase().includes(filter) || p.summary.toLowerCase().includes(filter))
        .slice(0, 30)
        .map(p => ({
          id: p.id,
          title: p.title,
          entryType: p.entryType ?? 'concept',
          sourceId: p.sourceId,
          tags: p.tags,
          backlinks: p.backlinks
        }));
      return { toolName: call.name, ok: true, data: filtered };
    }

    case 'get_wiki_links': {
      const pageId = typeof call.arguments.pageId === 'string' ? call.arguments.pageId : '';
      const title = typeof call.arguments.title === 'string' ? call.arguments.title.trim().toLowerCase() : '';
      const pages = await db.wiki_pages.toArray();
      const page = pageId
        ? pages.find(p => p.id === pageId)
        : pages.find(p => p.title.toLowerCase() === title);
      if (!page) {
        return { toolName: call.name, ok: false, error: 'Wiki page not found.' };
      }
      const linkedSourceIds = page.sourceId && approvedSet.has(page.sourceId) ? [page.sourceId] : [];
      const spans = linkedSourceIds.length
        ? (await db.reference_spans.where('sourceId').anyOf(linkedSourceIds).toArray())
          .slice(0, 6)
          .map(s => ({ spanId: s.id, sourceId: s.sourceId, contentHash: s.contentHash, text: s.text.slice(0, 400) }))
        : [];
      return {
        toolName: call.name,
        ok: true,
        data: {
          id: page.id,
          title: page.title,
          entryType: page.entryType ?? 'concept',
          summary: page.summary,
          approvedLinkedSourceIds: linkedSourceIds,
          approvedSpans: spans
        }
      };
    }

    case 'propose_patch': {
      if (!scope.documentContext) {
        return { toolName: call.name, ok: false, error: 'No active document context to patch.' };
      }
      const rawHunks = Array.isArray(call.arguments.hunks) ? call.arguments.hunks : [];
      const hunks: PatchHunkProposal[] = rawHunks
        .filter((h): h is Record<string, unknown> => Boolean(h) && typeof h === 'object')
        .map(h => ({
          targetText: typeof h.targetText === 'string' ? h.targetText : '',
          replacementText: typeof h.replacementText === 'string' ? h.replacementText : '',
          rationale: typeof h.rationale === 'string' ? h.rationale : undefined
        }));
      const result = applyPatchHunks(scope.documentContext.markdown, hunks);
      return {
        toolName: call.name,
        ok: result.appliedCount > 0,
        data: result,
        error: result.appliedCount === 0 ? 'None of the proposed patch hunks matched the active document.' : undefined
      };
    }

    default:
      return {
        toolName: call.name,
        ok: false,
        error: `Unknown tool: ${String(call.name)}`
      };
  }
}
