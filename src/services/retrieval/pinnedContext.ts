import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { loadTheory } from '../theory/documents';
import { resolveSourceIdsFromWikiIds } from '../wiki/wikiService';
import { searchBM25 } from './bm25';
import { createContextBundle, MAX_EVIDENCE_CHARS } from './context';
import { loadReferenceSelection } from './references';
import type { ContextBundle, RetrievalHit } from './types';

const MAX_PINNED_HITS = 8;

/**
 * Builds a ContextBundle strictly from references explicitly pinned to the active
 * research note version via "Add reference" (version.referenceIds).
 * Returns undefined when no references are pinned.
 */
export async function buildPinnedReferenceContextBundle(params: {
  documentId: string;
  query: string;
  db?: QaxiomDatabase;
}): Promise<ContextBundle | undefined> {
  const db = params.db ?? qaxiomDatabase;
  const query = params.query.trim();
  if (!query) return undefined;

  let referenceIds: string[] = [];
  try {
    const snapshot = await loadTheory(params.documentId, db);
    referenceIds = snapshot.version.referenceIds ?? [];
  } catch {
    return undefined;
  }

  if (referenceIds.length === 0) return undefined;

  const candidateSourceIds = await resolveSourceIdsFromWikiIds(referenceIds, db);
  if (candidateSourceIds.length === 0) return undefined;

  const existingRefs = (await db.references.bulkGet(candidateSourceIds)).filter(
    (ref): ref is NonNullable<typeof ref> => Boolean(ref)
  );
  const validSourceIds = existingRefs.map(ref => ref.id);
  if (validSourceIds.length === 0) return undefined;

  const selection = await loadReferenceSelection(validSourceIds, db);
  if (selection.referenceSpans.length === 0) return undefined;

  let hits = searchBM25(selection, query, MAX_PINNED_HITS);
  if (hits.length === 0) {
    // Broad questions ("summarize this paper") may not share keywords with the text;
    // fall back to leading spans of the pinned references so the model can still read them.
    const refById = new Map(selection.references.map(r => [r.id, r]));
    hits = selection.referenceSpans
      .slice()
      .sort((a, b) => a.position - b.position)
      .filter(span => refById.has(span.sourceId))
      .slice(0, MAX_PINNED_HITS)
      .map(span => ({
        source: refById.get(span.sourceId)!,
        span,
        score: 0.1
      }));
  }

  const boundedHits: RetrievalHit[] = [];
  let charCount = 0;
  for (const hit of hits) {
    if (boundedHits.length >= MAX_PINNED_HITS) break;
    if (charCount + hit.span.text.length > MAX_EVIDENCE_CHARS) continue;
    boundedHits.push(hit);
    charCount += hit.span.text.length;
  }

  if (boundedHits.length === 0) return undefined;
  return createContextBundle(params.query, validSourceIds, boundedHits);
}
