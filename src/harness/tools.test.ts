// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../constants';
import { QaxiomDatabase } from '../services/database';
import { parseMessageFileChanges } from '../services/fileChanges';
import { EMPTY_CONTRACT } from '../services/theory/types';
import { runTurn } from './runTurn';
import { applyPatchHunks, executeLocalToolCall } from './tools';

const dbs: QaxiomDatabase[] = [];

function createTestDb(name: string): QaxiomDatabase {
  const db = new QaxiomDatabase(name);
  dbs.push(db);
  return db;
}

describe('harness scoped local tools & propose_patch', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    while (dbs.length) {
      await dbs.pop()!.delete();
    }
  });

  it('blocks search_selected_references for unapproved sourceIds', async () => {
    const db = createTestDb(`tools-scope-${Date.now()}`);
    await db.reference_spans.put({
      id: 'span-secret',
      sourceId: 'src-unapproved',
      position: 0,
      startOffset: 0,
      endOffset: 11,
      startLine: 1,
      endLine: 1,
      text: 'Secret data',
      contentHash: 'h1'
    });

    const denied = await executeLocalToolCall(
      { name: 'search_selected_references', arguments: { sourceIds: ['src-unapproved'], query: 'secret' } },
      { approvedSourceIds: ['src-approved'], database: db }
    );
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('not approved');
  });

  it('navigates wiki_pages via list_wiki_index and resolves only approved spans in get_wiki_links', async () => {
    const db = createTestDb(`tools-wiki-${Date.now()}`);
    await db.wiki_pages.bulkPut([
      {
        id: 'wiki-1',
        title: 'Gauge Invariance',
        entryType: 'paper',
        sourceId: 'src-approved',
        summary: 'Symmetry under local transformations.',
        content: 'Details',
        tags: ['physics'],
        backlinks: [],
        createdAt: 1,
        updatedAt: 2
      },
      {
        id: 'wiki-2',
        title: 'Gauge Unapproved',
        entryType: 'paper',
        sourceId: 'src-unapproved',
        summary: 'Unapproved source.',
        content: 'Details',
        tags: ['physics'],
        backlinks: [],
        createdAt: 1,
        updatedAt: 2
      }
    ]);
    await db.reference_spans.bulkPut([
      {
        id: 'span-ok',
        sourceId: 'src-approved',
        position: 0,
        startOffset: 0,
        endOffset: 10,
        startLine: 1,
        endLine: 1,
        text: 'Approved theorem excerpt',
        contentHash: 'h-ok'
      },
      {
        id: 'span-no',
        sourceId: 'src-unapproved',
        position: 0,
        startOffset: 0,
        endOffset: 10,
        startLine: 1,
        endLine: 1,
        text: 'Unapproved excerpt',
        contentHash: 'h-no'
      }
    ]);

    const indexRes = await executeLocalToolCall(
      { name: 'list_wiki_index', arguments: { query: 'gauge' } },
      { approvedSourceIds: ['src-approved'], database: db }
    );
    expect(indexRes.ok).toBe(true);
    expect(indexRes.data).toHaveLength(2);

    const linksRes = await executeLocalToolCall(
      { name: 'get_wiki_links', arguments: { pageId: 'wiki-1' } },
      { approvedSourceIds: ['src-approved'], database: db }
    );
    expect(linksRes.ok).toBe(true);
    const data = linksRes.data as { approvedLinkedSourceIds: string[]; approvedSpans: Array<{ text: string }> };
    expect(data.approvedLinkedSourceIds).toEqual(['src-approved']);
    expect(data.approvedSpans.map(s => s.text)).toEqual(['Approved theorem excerpt']);

    const unapprovedLinksRes = await executeLocalToolCall(
      { name: 'get_wiki_links', arguments: { pageId: 'wiki-2' } },
      { approvedSourceIds: ['src-approved'], database: db }
    );
    const unapprovedData = unapprovedLinksRes.data as { approvedLinkedSourceIds: string[]; approvedSpans: Array<{ text: string }> };
    expect(unapprovedData.approvedLinkedSourceIds).toEqual([]);
    expect(unapprovedData.approvedSpans).toEqual([]);
  });

  it('applies propose_patch hunks cleanly in both tools and parseMessageFileChanges', () => {
    const base = '# Title\n\nOld assumption here.\n\nKeep this line.';
    const hunks = [
      { targetText: 'Old assumption here.', replacementText: 'Verified assumption here.', rationale: 'Fix' }
    ];
    const applied = applyPatchHunks(base, hunks);
    expect(applied.appliedCount).toBe(1);
    expect(applied.appliedMarkdown).toContain('Verified assumption here.');
    expect(applied.appliedMarkdown).toContain('Keep this line.');

    const msg = `Updated section.\n\n\`\`\`propose_patch:document.md\n${JSON.stringify({ hunks })}\n\`\`\``;
    const parsed = parseMessageFileChanges(msg, 'document.md', base);
    expect(parsed.displayText).toBe('Updated section.');
    expect(parsed.fileChanges).toHaveLength(1);
    expect(parsed.fileChanges[0].proposedContent).toBe(applied.appliedMarkdown);
    expect(parsed.fileChanges[0].hunks).toHaveLength(1);
  });

  it('runs bounded tool loop inside runTurn and stops at maxToolHops', async () => {
    let callCount = 0;
    let listener: ((event: import('../types/desktop').CliIpcEvent) => void) | null = null;
    vi.stubGlobal('window', {
      qaxiomDesktop: {
        isDesktop: true,
        getCliStatuses: vi.fn(),
        openCliLogin: vi.fn(),
        abortCli: vi.fn().mockResolvedValue(undefined),
        onCliEvent: (cb: (event: import('../types/desktop').CliIpcEvent) => void) => {
          listener = cb;
          return () => { listener = null; };
        },
        runCli: vi.fn().mockImplementation(async (req: { runId: string }) => {
          callCount++;
          const payload =
            callCount === 1
              ? '```qaxiom_tool\n{"name":"get_definition","arguments":{"symbol":"kappa"}}\n```'
              : 'Final answer using kappa = 1.';
          listener?.({ runId: req.runId, type: 'chunk', chunk: payload });
          listener?.({ runId: req.runId, type: 'finish' });
        })
      }
    });

    const onToolCall = vi.fn();
    const result = await runTurn(
      {
        kind: 'chat',
        messages: [{ id: 'u1', role: 'user', content: 'Define kappa', timestamp: 1 }],
        modelId: 'codex-cli',
        researchMode: 'general',
        enableToolLoop: true,
        maxToolHops: 2,
        documentContext: {
          documentId: 'd1',
          versionId: 'v1',
          title: 'Spec',
          markdown: '# Spec',
          contentHash: 'hash',
          contract: { ...EMPTY_CONTRACT, definitions: 'kappa = coupling constant' },
          capturedAt: 1
        },
        settings: DEFAULT_SETTINGS
      },
      { callbacks: { onToolCall } }
    );

    vi.unstubAllGlobals();
    expect(result.toolHopsUsed).toBe(1);
    expect(result.text).toBe('Final answer using kappa = 1.');
    expect(onToolCall).toHaveBeenCalledOnce();
  });
});
