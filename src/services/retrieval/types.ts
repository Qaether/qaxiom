export type ReferenceRole = 'external' | 'note' | 'theory_snapshot';

// Each import is an immutable source version. Identical UTF-8 text is deduplicated.
export interface ReferenceDocument {
  id: string;
  name: string;
  text: string;
  contentHash: string;
  role: ReferenceRole;
  originVersionId: string | null;
  createdAt: number;
  parserVersion: 'text-v1' | 'pdfjs-v1';
  pdf?: PdfSourceInfo;
}

export interface ReferenceSpan {
  page?: number;
  id: string;
  sourceId: string;
  position: number;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  text: string;
  contentHash: string;
}

export interface ReferenceData {
  references: ReferenceDocument[];
  referenceSpans: ReferenceSpan[];
}

export interface RetrievalHit {
  source: ReferenceDocument;
  span: ReferenceSpan;
  score: number;
}

export interface ContextEvidence {
  pdf?: { fileHash: string; pageCount: number; emptyPages: number[]; engineVersion: string };
  citationId: string;
  sourceId: string;
  sourceHash: string;
  name: string;
  role: ReferenceRole;
  originVersionId: string | null;
  span: ReferenceSpan;
  score: number;
}

export interface ContextBundle {
  id: string;
  version: 1;
  query: string;
  createdAt: number;
  retriever: 'bm25-text-v1' | 'hybrid-rrf-v1' | 'graph-canonical-v1';
  hybrid?: import('./embeddingTypes').HybridTrace;
  selectedSourceIds: string[];
  evidence: ContextEvidence[];
  projectScope?: { projectId: string; policyScope: 'external_review' | 'research' | null; policyRevision: number | null; policyHash: string | null; mode?: 'project_only' };
  graph?: {
    context: import('../theory/reviewGraphTypes').ReviewGraphContext;
    blocks: import('../theory/types').DocumentBlock[];
  };
  /** Additive v1 extension; legacy bundles without assembly remain readable. */
  assembly?: {
    matchedSpanIds: string[];
    parentSpanIds: string[];
    omittedSpanIds: string[];
    omissions: {
      spanId: string;
      sourceId: string;
      name: string;
      startLine: number;
      endLine: number;
      startOffset: number;
      endOffset: number;
      page?: number;
      reason: 'context_budget';
    }[];
    research: {
      documentId: string;
      versionId: string;
      number: number;
      title: string;
      contentHash: string;
      contract: import('../theory/types').ResearchContract;
      contractAnchors?: import('../theory/types').ContractAnchors;
      emptyFields: string[];
    } | null;
  };
}
import type { PdfSourceInfo } from './pdfTypes';
