// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QaxiomDatabase } from '../database';
import {
  syncReferenceToWiki,
  deleteReferenceFromWiki,
  publishTheoryToWiki,
  importWebToWiki,
  listWikiPages,
  getBoundWikiPagesForVersion,
  resolveSourceIdsFromWikiIds
} from './wikiService';
import type { ReferenceDocument } from '../retrieval/types';
import type { DocumentVersion, TheoryDocument } from '../theory/types';

let db: QaxiomDatabase;

beforeEach(async () => {
  db = new QaxiomDatabase(`qaxiom-test-wiki-${crypto.randomUUID()}`);
});

afterEach(async () => {
  db.close();
  await db.delete();
});

describe('wikiService', () => {
  it('syncs reference document to wiki_pages and deletes it', async () => {
    const ref: ReferenceDocument = {
      id: 'ref-1',
      name: 'Dirac_1928.pdf',
      text: 'The quantum theory of the electron. Spin is an intrinsic property.',
      contentHash: 'hash-dirac-1',
      role: 'external',
      originVersionId: null,
      createdAt: 1000,
      parserVersion: 'text-v1'
    };
    await db.references.add(ref);

    const wikiPage = await syncReferenceToWiki(ref, db);
    expect(wikiPage.id).toBe('wiki-ref-ref-1');
    expect(wikiPage.title).toBe('Dirac_1928.pdf');
    expect(wikiPage.entryType).toBe('paper');
    expect(wikiPage.summary).toContain('The quantum theory of the electron');

    const loaded = await db.wiki_pages.get('wiki-ref-ref-1');
    expect(loaded?.title).toBe('Dirac_1928.pdf');

    await deleteReferenceFromWiki('ref-1', db);
    expect(await db.wiki_pages.get('wiki-ref-ref-1')).toBeUndefined();
  });

  it('publishes a theory document version snapshot to wiki', async () => {
    const doc: TheoryDocument = {
      id: 'doc-1',
      projectId: 'proj-1',
      role: 'theory',
      currentVersionId: 'ver-1',
      createdAt: 1000,
      updatedAt: 1000
    };
    const version: DocumentVersion = {
      id: 'ver-1',
      documentId: 'doc-1',
      number: 2,
      parentVersionId: null,
      restoredFromVersionId: null,
      title: '양자격자공간',
      markdown: '# 양자격자공간\n\n진공의 FCC 격자 구조 가설.',
      contentHash: 'hash-v1',
      contract: {
        purpose: 'FCC 격자 상호작용 검증',
        assumptions: '',
        definitions: '',
        symbols: '',
        scope: '',
        openQuestions: ''
      },
      contractAnchors: {},
      createdAt: 1000
    };

    const wiki = await publishTheoryToWiki(doc, version, db);
    expect(wiki.id).toBe('wiki-theory-ver-1');
    expect(wiki.title).toBe('양자격자공간 (v2)');
    expect(wiki.entryType).toBe('theory_snapshot');
    expect(wiki.summary).toContain('FCC 격자 상호작용 검증');
  });

  it('imports web content to wiki and registers reference for RAG search', async () => {
    const wiki = await importWebToWiki(
      'https://arxiv.org/abs/2301.00001',
      'Quantum Geometry on Graphs',
      'This paper explores graph representations of physical spacetime geometry.',
      db
    );

    expect(wiki.entryType).toBe('web');
    expect(wiki.url).toBe('https://arxiv.org/abs/2301.00001');
    expect(wiki.sourceId).toBeDefined();

    // Verify it added to references and reference_spans
    const refDoc = await db.references.get(wiki.sourceId!);
    expect(refDoc).toBeDefined();
    expect(refDoc?.name).toContain('Quantum Geometry on Graphs (Web)');

    const spans = await db.reference_spans.where('sourceId').equals(wiki.sourceId!).toArray();
    expect(spans.length).toBeGreaterThan(0);
  });

  it('resolves bound wiki pages for document version', async () => {
    const ref: ReferenceDocument = {
      id: 'ref-x',
      name: 'Feynman.md',
      text: 'Path integrals and quantum mechanics.',
      contentHash: 'hash-feynman',
      role: 'external',
      originVersionId: null,
      createdAt: 1000,
      parserVersion: 'text-v1'
    };
    await db.references.add(ref);
    await syncReferenceToWiki(ref, db);

    const version: DocumentVersion = {
      id: 'v-test',
      documentId: 'd-test',
      number: 1,
      parentVersionId: null,
      restoredFromVersionId: null,
      title: '테스트',
      markdown: '본문',
      contentHash: 'hash-test',
      contract: { purpose: '', assumptions: '', definitions: '', symbols: '', scope: '', openQuestions: '' },
      contractAnchors: {},
      referenceIds: ['wiki-ref-ref-x'],
      createdAt: 1000
    };

    const bound = await getBoundWikiPagesForVersion(version, db);
    expect(bound.length).toBe(1);
    expect(bound[0].title).toBe('Feynman.md');

    const allPages = await listWikiPages(db);
    expect(allPages.length).toBe(1);

    const sourceIds = await resolveSourceIdsFromWikiIds(version.referenceIds!, db);
    expect(sourceIds).toEqual(['ref-x']);
  });
});
