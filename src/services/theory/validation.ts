import { hashText, splitMarkdown } from './blocks';
import { EMPTY_CONTRACT, type TheoryData, type ResearchContract, type ContractAnchors, type DocumentBlock } from './types';

type Row = Record<string, unknown>;
function fail(): never { throw new Error('이론 문서 백업의 필드·버전·블록 참조가 올바르지 않습니다.'); }
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Row;
}
function text(row: Row, key: string, empty = false): string {
  const value = row[key];
  if (typeof value !== 'string' || (!empty && !value.trim())) return fail();
  return value;
}
function number(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail();
  return value;
}
function nullable(row: Row, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}
function rows(data: Row, key: string): Row[] {
  const value = data[key];
  if (!Array.isArray(value)) return fail();
  return value.map(object);
}
function unique(values: string[]) { if (new Set(values).size !== values.length) fail(); }
function contract(value: unknown): ResearchContract {
  const row = object(value);
  return Object.fromEntries(Object.keys(EMPTY_CONTRACT).map(key => [key, text(row, key, true)])) as unknown as ResearchContract;
}
function contractAnchors(value: unknown, required: boolean): ContractAnchors {
  if (value === undefined && !required) return {};
  const row = object(value);
  const result: ContractAnchors = {};
  for (const [key, item] of Object.entries(row)) {
    if (!(key in EMPTY_CONTRACT)) fail();
    const anchor = object(item);
    const blockId = text(anchor, 'blockId'), blockHash = text(anchor, 'blockHash');
    if (!/^[a-f0-9]{64}$/.test(blockHash)) fail();
    result[key as keyof ResearchContract] = { blockId, blockHash };
  }
  return result;
}

import { parseProjectSourcePolicy } from './projectSources';

export function parseTheoryData(input: unknown, requireAnchors = false): TheoryData {
  const data = object(input);
  const projects = rows(data, 'projects').map(row => ({
    id: text(row, 'id'), title: text(row, 'title'), canonicalDocumentId: text(row, 'canonicalDocumentId'), createdAt: number(row, 'createdAt'),
    ...(row.sourcePolicy !== undefined ? { sourcePolicy: parseProjectSourcePolicy(row.sourcePolicy) } : {})
  }));
  const theoryDocuments = rows(data, 'theoryDocuments').map(row => {
    if (row.role !== 'theory') fail();
    return { id: text(row, 'id'), projectId: text(row, 'projectId'), role: 'theory' as const,
      currentVersionId: text(row, 'currentVersionId'), createdAt: number(row, 'createdAt'), updatedAt: number(row, 'updatedAt') };
  });
  const documentVersions = rows(data, 'documentVersions').map(row => ({
    id: text(row, 'id'), documentId: text(row, 'documentId'), number: number(row, 'number'),
    parentVersionId: nullable(row, 'parentVersionId'), restoredFromVersionId: nullable(row, 'restoredFromVersionId'),
    title: text(row, 'title'), markdown: text(row, 'markdown'), contentHash: text(row, 'contentHash'),
    contract: contract(row.contract), contractAnchors: contractAnchors(row.contractAnchors, requireAnchors), createdAt: number(row, 'createdAt'),
    ...(Array.isArray(row.referenceIds) ? { referenceIds: row.referenceIds.filter((id): id is string => typeof id === 'string') } : {})
  }));
  const documentBlocks = rows(data, 'documentBlocks').map(row => {
    if (!['heading', 'paragraph', 'code', 'math'].includes(text(row, 'kind'))) fail();
    if (!Array.isArray(row.predecessorIds) || row.predecessorIds.some(id => typeof id !== 'string' || !id)) fail();
    return {
      id: text(row, 'id'), versionId: text(row, 'versionId'), documentId: text(row, 'documentId'),
      position: number(row, 'position'), kind: row.kind as DocumentBlock['kind'],
      startOffset: number(row, 'startOffset'), endOffset: number(row, 'endOffset'),
      text: text(row, 'text'), contentHash: text(row, 'contentHash'), predecessorIds: [...row.predecessorIds] as string[]
    };
  });
  for (const group of [projects, theoryDocuments, documentVersions]) unique(group.map(row => row.id));
  unique(documentBlocks.map(row => JSON.stringify([row.versionId, row.id])));
  unique(documentVersions.map(row => JSON.stringify([row.documentId, row.number])));
  const projectMap = new Map(projects.map(row => [row.id, row]));
  const docs = new Map(theoryDocuments.map(row => [row.id, row]));
  const versions = new Map(documentVersions.map(row => [row.id, row]));
  const blocks = new Map<string, DocumentBlock[]>();
  for (const block of documentBlocks) {
    if (versions.get(block.versionId)?.documentId !== block.documentId) fail();
    blocks.set(block.versionId, [...(blocks.get(block.versionId) || []), block]);
  }
  for (const project of projects) if (docs.get(project.canonicalDocumentId)?.projectId !== project.id) fail();
  for (const doc of theoryDocuments) {
    if (!projectMap.has(doc.projectId) || versions.get(doc.currentVersionId)?.documentId !== doc.id) fail();
    const history = documentVersions.filter(version => version.documentId === doc.id).sort((a, b) => a.number - b.number);
    if (history.at(-1)?.id !== doc.currentVersionId) fail();
    for (let index = 0; index < history.length; index++) {
      if (history[index].number !== index + 1 || history[index].parentVersionId !== (history[index - 1]?.id || null)) fail();
    }
  }
  for (const version of documentVersions) {
    if (!docs.has(version.documentId)) fail();
    if (version.restoredFromVersionId) {
      const source = versions.get(version.restoredFromVersionId);
      if (!source || source.documentId !== version.documentId || source.number >= version.number) fail();
    }
    const actual = (blocks.get(version.id) || []).sort((a, b) => a.position - b.position);
    for (const [field, anchor] of Object.entries(version.contractAnchors)) {
      if (!version.contract[field as keyof ResearchContract].trim()
        || !actual.some(block => block.id === anchor.blockId && block.contentHash === anchor.blockHash)) fail();
    }
    const expected = splitMarkdown(version.markdown);
    if (expected.length !== actual.length) fail();
    const parentIds = new Set((blocks.get(version.parentVersionId || '') || []).map(block => block.id));
    actual.forEach((block, index) => {
      const part = expected[index];
      if (block.position !== index || block.startOffset !== part.startOffset || block.endOffset !== part.endOffset
        || block.text !== part.text || block.kind !== part.kind || block.predecessorIds.some(id => !parentIds.has(id))) fail();
    });
  }
  return { projects, theoryDocuments, documentVersions, documentBlocks };
}

export async function verifyTheoryHashes(data: TheoryData) {
  for (const version of data.documentVersions) {
    if (await hashText(version.markdown) !== version.contentHash) throw new Error('문서 본문의 해시가 일치하지 않습니다.');
  }
  for (const block of data.documentBlocks) {
    if (await hashText(block.text) !== block.contentHash) throw new Error('문서 블록의 해시가 일치하지 않습니다.');
  }
}
