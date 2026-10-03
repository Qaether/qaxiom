import { hashText } from '../theory/blocks';
import type { DocumentVersion } from '../theory/types';
import { MAX_REFERENCE_BYTES, splitReference } from './references';
import { MAX_EVIDENCE_CHARS } from './context';
import type { ContextBundle, ReferenceData, ReferenceDocument, ReferenceSpan } from './types';
import type { PdfAsset, PdfSourceInfo } from './pdfTypes';
import { MAX_PDF_TEXT } from './pdfTypes';
import { assemblePdfPages } from './pdfLayout';
import { assembleContext, sameContextValue } from './assembly';
import { parseGraphContext, type GraphRestoreData } from './graphContext';
import { parseRagProjectScope } from './projectScope';

function fail(): never { throw new Error('레퍼런스·인용의 필드 또는 원문 참조가 올바르지 않습니다.'); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const role = (value: unknown) => ['external', 'note', 'theory_snapshot'].includes(String(value));
const unique = (values: string[]) => { if (new Set(values).size !== values.length) fail(); };

export function parseReferenceData(input: unknown, versions: DocumentVersion[], assets: PdfAsset[] = []): ReferenceData {
  if (!record(input) || !Array.isArray(input.references) || !Array.isArray(input.referenceSpans)) fail();
  const references = input.references.map((source: unknown) => {
    if (!record(source) || !text(source.id) || !text(source.name) || !text(source.text)
      || !text(source.contentHash) || !role(source.role) || !integer(source.createdAt)
      || !['text-v1', 'pdfjs-v1'].includes(String(source.parserVersion)) || (source.originVersionId !== null && !text(source.originVersionId))) fail();
    if (source.parserVersion === 'text-v1' && (new TextEncoder().encode(source.text).byteLength > MAX_REFERENCE_BYTES || source.text.includes('\u0000') || source.pdf !== undefined)) fail();
    let pdf: PdfSourceInfo | undefined;
    if (source.parserVersion === 'pdfjs-v1') {
      if (!record(source.pdf) || typeof source.pdf.assetId !== 'string') fail();
      const metadata = source.pdf;
      const asset = assets.find(asset => asset.id === metadata.assetId);
      if (!asset || !['ready', 'partial'].includes(asset.status) || source.id !== `pdf-${asset.id}` || source.name !== asset.name) fail();
      const assembled = assemblePdfPages(asset.pages);
      if (source.text !== assembled.text || source.text.length > MAX_PDF_TEXT + 2 * asset.pageCount
        || metadata.fileHash !== asset.fileHash || metadata.pageCount !== asset.pageCount || metadata.engineVersion !== asset.engineVersion
        || JSON.stringify(metadata.pages) !== JSON.stringify(assembled.locations)) fail();
      pdf = { assetId: asset.id, fileHash: asset.fileHash, pageCount: asset.pageCount, engineVersion: asset.engineVersion, pages: assembled.locations };
      if (source.originVersionId === null && source.role !== asset.role) fail();
    }
    if (source.originVersionId !== null && (source.role !== 'theory_snapshot'
      || !versions.some(version => version.id === source.originVersionId && version.markdown === source.text))) fail();
    return { id: source.id, name: source.name, text: source.text, contentHash: source.contentHash,
      role: source.role, originVersionId: source.originVersionId, createdAt: source.createdAt, parserVersion: source.parserVersion,
      ...(pdf ? { pdf } : {}) } as ReferenceDocument;
  });
  const referenceSpans = input.referenceSpans.map((span: unknown) => {
    if (!record(span) || !text(span.id) || !text(span.sourceId) || !text(span.text) || !text(span.contentHash)
      || !['position', 'startOffset', 'endOffset', 'startLine', 'endLine'].every(key => integer(span[key]))) fail();
    if (span.page !== undefined && (!integer(span.page) || span.page < 1)) fail();
    return { id: span.id, sourceId: span.sourceId, position: span.position, startOffset: span.startOffset,
      endOffset: span.endOffset, startLine: span.startLine, endLine: span.endLine, text: span.text, contentHash: span.contentHash,
      ...(span.page !== undefined ? { page: span.page } : {}) } as ReferenceSpan;
  });
  unique(references.map(source => source.id)); unique(references.filter(source => source.parserVersion === 'text-v1').map(source => source.contentHash));
  for (const asset of assets) {
    const published = references.some(source => source.pdf?.assetId === asset.id);
    if (published !== ['ready', 'partial'].includes(asset.status)) fail();
  }
  unique(referenceSpans.map(span => span.id));
  const bySource = new Map<string, ReferenceSpan[]>();
  const sourceIds = new Set(references.map(source => source.id));
  for (const span of referenceSpans) {
    if (!sourceIds.has(span.sourceId)) fail();
    const group = bySource.get(span.sourceId) || [];
    group.push(span); bySource.set(span.sourceId, group);
  }
  for (const source of references) {
    const expected = source.pdf ? assemblePdfPages(assets.find(asset => asset.id === source.pdf!.assetId)!.pages).spans : splitReference(source.text);
    const spans = (bySource.get(source.id) || []).sort((a, b) => a.position - b.position);
    if (spans.length !== expected.length) fail();
    spans.forEach((span, index) => {
      const part = expected[index];
      if (span.position !== index || span.text !== part.text || span.startOffset !== part.startOffset
        || span.endOffset !== part.endOffset || span.startLine !== part.startLine || span.endLine !== part.endLine
        || span.page !== ('page' in part ? part.page : undefined)) fail();
    });
  }
  return { references, referenceSpans };
}

export function parseContextBundle(input: unknown, data: ReferenceData, versions: DocumentVersion[], embeddings?: import('./embeddingTypes').EmbeddingData, graphData?: GraphRestoreData): ContextBundle {
  if (!record(input) || !text(input.id) || input.version !== 1 || !text(input.query) || !integer(input.createdAt)
    || !['bm25-text-v1', 'hybrid-rrf-v1', 'graph-canonical-v1'].includes(String(input.retriever)) || !Array.isArray(input.selectedSourceIds)
    || !input.selectedSourceIds.every(text) || !Array.isArray(input.evidence)
    || (input.retriever !== 'graph-canonical-v1' && !input.evidence.length) || input.evidence.length > 8) fail();
  const canonicalOnly = input.retriever === 'graph-canonical-v1';
  if (canonicalOnly && (input.evidence.length || input.selectedSourceIds.length || input.graph === undefined || input.assembly === undefined)) fail();
  const selectedSourceIds = input.selectedSourceIds as string[];
  unique(selectedSourceIds);
  const sources = new Map(data.references.map(source => [source.id, source]));
  const spans = new Map(data.referenceSpans.map(span => [span.id, span]));
  if (selectedSourceIds.some(id => !sources.has(id))) fail();
  const evidence = input.evidence.map((item: unknown, index: number) => {
    if (!record(item) || item.citationId !== `R${index + 1}` || !text(item.sourceId)
      || !record(item.span) || !text(item.span.id) || !role(item.role)
      || typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score <= 0) fail();
    const source = sources.get(item.sourceId), span = spans.get(item.span.id);
    if (!source || !span || !selectedSourceIds.includes(source.id) || span.sourceId !== source.id
      || source.name !== item.name || source.contentHash !== item.sourceHash) fail();
    for (const key of Object.keys(span) as (keyof ReferenceSpan)[]) if (span[key] !== item.span[key]) fail();
    const sameOrigin = item.role === source.role && item.originVersionId === source.originVersionId;
    const derivedOwn = item.role === 'theory_snapshot' && versions.some(version => version.id === item.originVersionId && version.markdown === source.text);
    if (!sameOrigin && !derivedOwn) fail();
    const pdf = source.pdf ? { fileHash: source.pdf.fileHash, pageCount: source.pdf.pageCount,
      engineVersion: source.pdf.engineVersion, emptyPages: source.pdf.pages.filter(page => page.status === 'empty').map(page => page.number) } : undefined;
    if (pdf) {
      if (!record(item.pdf) || item.pdf.fileHash !== pdf.fileHash || item.pdf.pageCount !== pdf.pageCount
        || item.pdf.engineVersion !== pdf.engineVersion || JSON.stringify(item.pdf.emptyPages) !== JSON.stringify(pdf.emptyPages)) fail();
    } else if (item.pdf !== undefined) fail();
    return { citationId: String(item.citationId), sourceId: source.id, sourceHash: source.contentHash,
      name: source.name, role: item.role as ReferenceDocument['role'], originVersionId: item.originVersionId as string | null,
      span: { ...span }, score: item.score, ...(pdf ? { pdf } : {}) };
  });
  unique(evidence.map(item => item.span.id));
  if (evidence.reduce((sum, item) => sum + item.span.text.length, 0) > MAX_EVIDENCE_CHARS) fail();
  const bundle: ContextBundle = { id: input.id, version: 1, query: input.query, createdAt: input.createdAt,
    retriever: input.retriever as ContextBundle['retriever'], selectedSourceIds, evidence };
  if (input.retriever === 'hybrid-rrf-v1') {
    const trace = input.hybrid;
    if (!record(trace) || !text(trace.spaceId) || trace.model !== 'text-embedding-3-small' || trace.dimensions !== 512
      || trace.adapterVersion !== 'openai-embedding-v1' || trace.providerRevision !== null
      || !Array.isArray(trace.coveredSpanIds) || !trace.coveredSpanIds.length || !trace.coveredSpanIds.every(text)
      || !Array.isArray(trace.missingSpanIds) || !trace.missingSpanIds.every(text)) fail();
    const covered = trace.coveredSpanIds as string[], missing = trace.missingSpanIds as string[];
    unique([...covered, ...missing]);
    const selectedSpans = data.referenceSpans.filter(s => selectedSourceIds.includes(s.sourceId));
    const space = embeddings?.embeddingSpaces.find(s => s.id === trace.spaceId);
    if (!space || space.model !== trace.model || space.dimensions !== trace.dimensions || space.adapterVersion !== trace.adapterVersion
      || [...covered, ...missing].length !== selectedSpans.length || [...covered, ...missing].some(id => !selectedSpans.some(s => s.id === id))
      || covered.some(id => !embeddings?.embeddingVectors.some(v => v.spaceId === space.id && v.spanId === id))) fail();
    bundle.hybrid = { spaceId: space.id, model: space.model, dimensions: space.dimensions, adapterVersion: space.adapterVersion,
      providerRevision: null, coveredSpanIds: covered, missingSpanIds: missing };
    if (trace.manifestHash !== undefined || trace.activationRevision !== undefined) {
      if (!text(trace.manifestHash) || !Number.isSafeInteger(trace.activationRevision) || (trace.activationRevision as number) < 1
        || missing.length || !embeddings?.embeddingManifests.some(m => m.spaceId === space.id && m.manifestHash === trace.manifestHash
          && selectedSourceIds.every(id => m.sources.some(s => s.id === id)) && covered.every(id => m.spans.some(s => s.id === id)))) fail();
      bundle.hybrid.manifestHash = trace.manifestHash;
      bundle.hybrid.activationRevision = trace.activationRevision as number;
    }
  } else if (input.hybrid !== undefined) fail();
  if (input.assembly !== undefined) {
    const assembly = input.assembly;
    if (!record(assembly) || !Array.isArray(assembly.matchedSpanIds) || (!canonicalOnly && !assembly.matchedSpanIds.length)
      || !assembly.matchedSpanIds.every(text) || !Array.isArray(assembly.parentSpanIds)
      || !assembly.parentSpanIds.every(text) || !Array.isArray(assembly.omittedSpanIds)
      || !assembly.omittedSpanIds.every(text)) fail();
    unique(assembly.matchedSpanIds as string[]);
    let version: DocumentVersion | null = null;
    if (assembly.research !== null) {
      if (!record(assembly.research)) fail();
      version = versions.find(version => version.id === (assembly.research as Record<string, unknown>).versionId) ?? null;
      if (!version) fail();
    }
    const matched = (assembly.matchedSpanIds as string[]).map(id => {
      const item = evidence.find(item => item.span.id === id);
      if (!item) fail();
      return { source: { ...sources.get(item.sourceId)!, role: item.role, originVersionId: item.originVersionId }, span: item.span, score: item.score };
    });
    // A reference can have become a canonical snapshot after initial ingestion.
    // Its derived provenance was verified above; preserve it in structural expansion.
    const contextData = { ...data, references: data.references.map(source => {
      const item = evidence.find(item => item.sourceId === source.id);
      return item ? { ...source, role: item.role, originVersionId: item.originVersionId } : source;
    }) };
    if (input.graph !== undefined) {
      if (!graphData || !version) fail();
      bundle.graph = parseGraphContext(input.graph, version.id, graphData);
    }
    const expected = assembleContext(input.query, selectedSourceIds, matched, contextData, version, bundle.graph);
    // Compare each declared field rather than trusting omitted ranges or a copied contract.
    for (const key of ['matchedSpanIds', 'parentSpanIds', 'omittedSpanIds', 'omissions', 'research'] as const) {
      if (!sameContextValue(assembly[key], expected.assembly![key])) fail();
    }
    if (!sameContextValue(evidence, expected.evidence)) fail();
    bundle.assembly = expected.assembly;
  }
  if (input.graph !== undefined && !bundle.graph) fail();
  if (input.projectScope !== undefined) {
    bundle.projectScope = parseRagProjectScope(input.projectScope);
    if (!bundle.assembly || (!!bundle.assembly.research === (bundle.projectScope.mode === 'project_only')) || (bundle.projectScope.mode === 'project_only' && bundle.graph)) fail();
  }
  return bundle;
}

export async function verifyReferenceHashes(data: ReferenceData) {
  for (const source of data.references) if (await hashText(source.text) !== source.contentHash) fail();
  for (const span of data.referenceSpans) if (await hashText(span.text) !== span.contentHash) fail();
}
