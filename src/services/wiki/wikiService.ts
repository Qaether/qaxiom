import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import type { WikiPage, WikiEntryType } from '../../types';
import type { ReferenceDocument } from '../retrieval/types';
import type { DocumentVersion, TheoryDocument } from '../theory/types';
import { hashText } from '../theory/blocks';
import { splitReference } from '../retrieval/references';

/**
 * Synchronizes an imported ReferenceDocument (PDF or Markdown/TXT) to a WikiPage.
 */
export async function syncReferenceToWiki(
  reference: ReferenceDocument,
  db: QaxiomDatabase = qaxiomDatabase
): Promise<WikiPage> {
  const wikiId = `wiki-ref-${reference.id}`;
  const isPdf = reference.name.toLowerCase().endsWith('.pdf');
  const entryType: WikiEntryType = reference.role === 'note' ? 'note'
    : reference.role === 'theory_snapshot' ? 'theory_snapshot' : 'paper';

  // Extract clean summary from first 300 characters
  const summary = reference.text.trim().slice(0, 300).replace(/\n+/g, ' ');

  const page: WikiPage = {
    id: wikiId,
    title: reference.name,
    summary,
    content: reference.text,
    entryType,
    sourceId: reference.id,
    contentHash: reference.contentHash,
    tags: [entryType, isPdf ? 'pdf' : 'markdown'],
    backlinks: [],
    createdAt: reference.createdAt,
    updatedAt: Date.now()
  };

  await db.wiki_pages.put(page);
  return page;
}

/**
 * Removes the corresponding WikiPage when a ReferenceDocument is deleted.
 */
export async function deleteReferenceFromWiki(
  sourceId: string,
  db: QaxiomDatabase = qaxiomDatabase
): Promise<void> {
  const wikiId = `wiki-ref-${sourceId}`;
  await db.wiki_pages.delete(wikiId);
}

/**
 * Publishes an immutable version of a Theory Document (Research Note) to the Wiki.
 */
export async function publishTheoryToWiki(
  document: TheoryDocument,
  version: DocumentVersion,
  db: QaxiomDatabase = qaxiomDatabase
): Promise<WikiPage> {
  const wikiId = `wiki-theory-${version.id}`;

  const summary = version.contract.purpose?.trim()
    || version.markdown.trim().slice(0, 300).replace(/\n+/g, ' ');

  const page: WikiPage = {
    id: wikiId,
    title: `${version.title} (v${version.number})`,
    summary: `[내부 연구 스냅샷 v${version.number}] ${summary}`,
    content: version.markdown,
    entryType: 'theory_snapshot',
    versionId: version.id,
    documentId: document.id,
    contentHash: version.contentHash,
    tags: ['theory_snapshot', `v${version.number}`],
    backlinks: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  await db.wiki_pages.put(page);
  return page;
}

/**
 * Imports a web URL article into the Wiki as a web entry.
 * Also registers it into `db.references` and `db.reference_spans` so BM25 and vector search work seamlessly!
 */
export async function importWebToWiki(
  url: string,
  title: string,
  content: string,
  db: QaxiomDatabase = qaxiomDatabase
): Promise<WikiPage> {
  if (!url.trim()) throw new Error('유효한 웹 URL을 입력해 주세요.');
  if (!content.trim()) throw new Error('웹 페이지 본문 텍스트가 비어 있습니다.');

  const contentHash = await hashText(content);
  const sourceId = crypto.randomUUID();
  const wikiId = `wiki-web-${sourceId}`;
  const now = Date.now();
  const cleanTitle = title.trim() || url.trim();

  // Create ReferenceDocument & Spans for full RAG & BM25 searchability
  const spans = splitReference(content).map((span, position) => ({
    ...span,
    id: crypto.randomUUID(),
    sourceId,
    position,
    contentHash: ''
  }));

  for (const span of spans) {
    span.contentHash = await hashText(span.text);
  }

  const refDoc: ReferenceDocument = {
    id: sourceId,
    name: `${cleanTitle} (Web)`,
    text: content,
    contentHash,
    role: 'external',
    originVersionId: null,
    createdAt: now,
    parserVersion: 'text-v1'
  };

  const wikiPage: WikiPage = {
    id: wikiId,
    title: cleanTitle,
    summary: content.trim().slice(0, 300).replace(/\n+/g, ' '),
    content,
    entryType: 'web',
    sourceId,
    url: url.trim(),
    contentHash,
    tags: ['web', 'external'],
    backlinks: [],
    createdAt: now,
    updatedAt: now
  };

  await db.transaction('rw', [db.wiki_pages, db.references, db.reference_spans], async () => {
    await db.references.add(refDoc);
    await db.reference_spans.bulkAdd(spans);
    await db.wiki_pages.put(wikiPage);
  });

  return wikiPage;
}

/**
 * Lists all WikiPages, with automatic self-healing sync from existing references if wiki is empty.
 */
export async function listWikiPages(db: QaxiomDatabase = qaxiomDatabase): Promise<WikiPage[]> {
  const pages = await db.wiki_pages.orderBy('updatedAt').reverse().toArray();
  if (pages.length > 0) return pages;

  // Auto-sync from references if wiki_pages is empty
  const refs = await db.references.toArray();
  if (refs.length === 0) return [];

  const syncedPages: WikiPage[] = [];
  for (const ref of refs) {
    const page = await syncReferenceToWiki(ref, db);
    syncedPages.push(page);
  }
  return syncedPages.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Retrieves the WikiPages currently bound to a given DocumentVersion.
 */
export async function getBoundWikiPagesForVersion(
  version: DocumentVersion,
  db: QaxiomDatabase = qaxiomDatabase
): Promise<WikiPage[]> {
  const refIds = version.referenceIds ?? [];
  if (refIds.length === 0) return [];

  const allPages = await listWikiPages(db);
  // Match either by wiki.id or wiki.sourceId or wiki.versionId
  return allPages.filter(page =>
    refIds.includes(page.id) ||
    (page.sourceId && refIds.includes(page.sourceId)) ||
    (page.versionId && refIds.includes(page.versionId))
  );
}

/**
 * Resolves source IDs (for RAG search) from a list of bound WikiPage IDs.
 */
export async function resolveSourceIdsFromWikiIds(
  boundWikiIds: string[],
  db: QaxiomDatabase = qaxiomDatabase
): Promise<string[]> {
  if (boundWikiIds.length === 0) return [];
  const pages = await db.wiki_pages.toArray();
  const sourceIds: string[] = [];

  for (const id of boundWikiIds) {
    const page = pages.find(p => p.id === id || p.sourceId === id || p.versionId === id);
    if (page?.sourceId) {
      sourceIds.push(page.sourceId);
    } else {
      sourceIds.push(id);
    }
  }
  return [...new Set(sourceIds)];
}
