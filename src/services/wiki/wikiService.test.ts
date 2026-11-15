// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../constants';
import { QaxiomDatabase } from '../database';
import { curateWikiEntry } from './wikiService';

const dbs: QaxiomDatabase[] = [];

function createTestDb(name: string): QaxiomDatabase {
  const db = new QaxiomDatabase(name);
  dbs.push(db);
  return db;
}

describe('wikiService curation via harness', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    while (dbs.length) {
      await dbs.pop()!.delete();
    }
  });

  it('curates a wiki page via wiki_curate while preserving sourceId, hash, and note/paper separation', async () => {
    const db = createTestDb(`wiki-curate-${Date.now()}`);
    await db.references.put({
      id: 'ref-note-1',
      name: 'Internal Memo.md',
      text: 'Internal derivation note on symmetry.',
      contentHash: 'hash-note-1',
      role: 'note',
      originVersionId: 'ver-1',
      createdAt: 1,
      parserVersion: 'text-v1'
    });
    await db.reference_spans.put({
      id: 'span-1',
      sourceId: 'ref-note-1',
      position: 0,
      startOffset: 0,
      endOffset: 38,
      startLine: 1,
      endLine: 1,
      text: 'Internal derivation note on symmetry.',
      contentHash: 'hash-span-1'
    });

    const encoder = new TextEncoder();
    const curatedJson = JSON.stringify({
      title: 'Symmetry Memo',
      summary: 'Summary from approved spans.',
      content: 'Curated details referencing span-1.',
      tags: ['symmetry', 'draft'],
      backlinks: ['wiki-other']
    });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: curatedJson })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const page = await curateWikiEntry({
      sourceId: 'ref-note-1',
      modelId: 'gpt-6-astra',
      settings: {
        ...DEFAULT_SETTINGS,
        apiKeys: { ...DEFAULT_SETTINGS.apiKeys, openai: 'sk-test-openai-key-123456' }
      },
      db
    });

    expect(page.entryType).toBe('note');
    expect(page.sourceId).toBe('ref-note-1');
    expect(page.contentHash).toBe('hash-note-1');
    expect(page.title).toBe('Symmetry Memo');
    expect(page.tags).toEqual(['symmetry', 'draft']);
    expect((await db.wiki_pages.get(page.id))?.summary).toBe('Summary from approved spans.');
  });
});
