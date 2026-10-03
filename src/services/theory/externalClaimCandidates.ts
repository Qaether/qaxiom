import { scoreBM25Texts, tokenize } from '../retrieval/bm25';
import type { ProjectExternalClaimEntry } from './externalClaims';

export interface ExternalClaimCandidate {
  entry: ProjectExternalClaimEntry;
  score: number;
  sharedTerms: string[];
}

/** Local lexical suggestions only. Scores do not classify semantic relations. */
export function suggestExternalClaimCandidates(
  selected: ProjectExternalClaimEntry,
  otherProjectClaims: ProjectExternalClaimEntry[],
  limit = 12
): ExternalClaimCandidate[] {
  if (selected.status !== 'current') return [];
  const current = otherProjectClaims.filter(entry => entry.status === 'current'
    && entry.row.projectId !== selected.row.projectId && entry.row.id !== selected.row.id);
  const query = selected.row.claim.statement;
  const queryTerms = new Set(tokenize(query).filter(term => term.length >= 3 || term.startsWith('ko:')));
  if (!queryTerms.size) return [];
  const scores = scoreBM25Texts(current.map(entry => entry.row.claim.statement), query);
  return current.flatMap((entry, index) => {
    const sharedTerms = [...new Set(tokenize(entry.row.claim.statement))].filter(term => queryTerms.has(term));
    if (!sharedTerms.length || scores[index] <= 0) return [];
    return [{ entry, score: scores[index], sharedTerms: sharedTerms.slice(0, 8) }];
  }).sort((a, b) => b.score - a.score || a.entry.row.id.localeCompare(b.entry.row.id)).slice(0, Math.max(0, limit));
}
