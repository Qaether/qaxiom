import type { ReferenceData, RetrievalHit } from './types';

// Baseline, not a morphological analyzer: normalized words + Hangul bigrams.
export function tokenize(text: string): string[] {
  return (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).flatMap(word => {
    const tokens = [word];
    for (const run of word.match(/[가-힣]{2,}/g) || []) {
      for (let index = 0; index < run.length - 1; index++) tokens.push(`ko:${run.slice(index, index + 2)}`);
    }
    return tokens;
  });
}

export function scoreBM25Texts(texts: string[], query: string): number[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return texts.map(() => 0);
  const documents = texts.map(text => {
    const tokens = tokenize(text);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    return { counts, length: tokens.length };
  });
  if (!documents.length) return [];
  const average = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length || 1;
  const idf = new Map(terms.map(term => {
    const frequency = documents.filter(doc => doc.counts.has(term)).length;
    return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
  }));
  const k1 = 1.2, b = 0.75;
  return documents.map(({ counts, length }) => terms.reduce((score, term) => {
      const tf = counts.get(term) || 0;
      return score + idf.get(term)! * tf * (k1 + 1) / (tf + k1 * (1 - b + b * length / average));
    }, 0));
}

export function searchBM25(data: ReferenceData, query: string, limit = 12): RetrievalHit[] {
  const sources = new Map(data.references.map(source => [source.id, source]));
  const spans = data.referenceSpans.filter(span => sources.has(span.sourceId));
  const scores = scoreBM25Texts(spans.map(span => span.text), query);
  return spans.map((span, index) => ({ source: sources.get(span.sourceId)!, span, score: scores[index] })).filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.source.id.localeCompare(b.source.id) || a.span.position - b.span.position)
    .slice(0, Math.max(0, limit));
}
