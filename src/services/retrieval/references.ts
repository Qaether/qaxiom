import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { hashText, splitMarkdown } from '../theory/blocks';
import type { ReferenceDocument, ReferenceRole, ReferenceSpan } from './types';

export const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;
export const MAX_SPAN_CHARS = 2400;

export function splitReference(text: string) {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') lineStarts.push(index + 1);
  const lineAt = (offset: number) => {
    let low = 0, high = lineStarts.length;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (lineStarts[mid] <= offset) low = mid; else high = mid;
    }
    return low + 1;
  };
  return splitMarkdown(text).flatMap(block => {
    const spans = [];
    for (let start = block.startOffset; start < block.endOffset;) {
      let end = Math.min(start + MAX_SPAN_CHARS, block.endOffset);
      // Do not split a UTF-16 surrogate pair; source offsets remain UTF-16 offsets.
      if (end < block.endOffset && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      if (text.slice(start, end).trim()) spans.push({
        startOffset: start, endOffset: end, startLine: lineAt(start), endLine: lineAt(end - 1), text: text.slice(start, end)
      });
      start = end;
    }
    return spans;
  });
}

export async function importReference(
  name: string, text: string, role: ReferenceRole, db: QaxiomDatabase = qaxiomDatabase
): Promise<{ source: ReferenceDocument; duplicate: boolean }> {
  if (!/\.(md|markdown|txt)$/i.test(name)) throw new Error('텍스트 등록은 Markdown(.md)과 UTF-8 TXT 파일만 지원합니다.');
  if (!['external', 'note', 'theory_snapshot'].includes(role)) throw new Error('문서 종류가 올바르지 않습니다.');
  if (!text.trim() || text.includes('\u0000')) throw new Error('비어 있거나 텍스트가 아닌 파일입니다.');
  if (new TextEncoder().encode(text).byteLength > MAX_REFERENCE_BYTES) throw new Error('레퍼런스는 파일당 2 MB 이하여야 합니다.');
  const contentHash = await hashText(text);
  const id = crypto.randomUUID();
  const spans: ReferenceSpan[] = await Promise.all(splitReference(text).map(async (span, position) => ({
    ...span, id: crypto.randomUUID(), sourceId: id, position, contentHash: await hashText(span.text)
  })));
  return db.transaction('rw', [db.references, db.reference_spans, db.document_versions], async () => {
    const existing = await db.references.where('contentHash').equals(contentHash).filter(source => source.parserVersion === 'text-v1').first();
    const ownVersion = await db.document_versions.where('contentHash').equals(contentHash).first();
    // Never silently promote an existing note or own document to independent evidence.
    if (existing) {
      if ((ownVersion || role === 'theory_snapshot') && existing.role !== 'theory_snapshot') {
        throw new Error('같은 내용이 다른 종류로 이미 등록되어 있습니다. 기존 자료의 출처를 확인해 주세요.');
      }
      return { source: existing, duplicate: true };
    }
    const source: ReferenceDocument = {
      id, name, text, contentHash, role: ownVersion ? 'theory_snapshot' : role,
      originVersionId: ownVersion?.id || null, createdAt: Date.now(), parserVersion: 'text-v1'
    };
    await db.references.add(source);
    await db.reference_spans.bulkAdd(spans);
    return { source, duplicate: false };
  });
}

export async function importReferenceFile(file: File, role: ReferenceRole) {
  if (file.size > MAX_REFERENCE_BYTES) throw new Error('레퍼런스는 파일당 2 MB 이하여야 합니다.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error('UTF-8 텍스트 파일을 선택해 주세요.'); }
  return importReference(file.name, text, role);
}

export async function loadReferenceSelection(ids: string[], db: QaxiomDatabase = qaxiomDatabase) {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) throw new Error('검색할 레퍼런스를 선택해 주세요.');
  return db.transaction('r', [db.references, db.reference_spans, db.document_versions], async () => {
    const sources = await db.references.bulkGet(uniqueIds);
    if (sources.some(source => !source)) throw new Error('선택한 레퍼런스가 없습니다. 목록을 다시 열어 주세요.');
    // A theory may have been created after the reference was imported.
    const references = await Promise.all((sources as ReferenceDocument[]).map(async source => {
      const own = await db.document_versions.where('contentHash').equals(source.contentHash).first();
      return own ? { ...source, role: 'theory_snapshot' as const, originVersionId: own.id } : source;
    }));
    return { references, referenceSpans: await db.reference_spans.where('sourceId').anyOf(uniqueIds).toArray() };
  });
}
