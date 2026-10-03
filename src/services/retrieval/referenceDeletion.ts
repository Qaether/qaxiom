import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import type { ReferenceDocument } from './types';
import { hashBytes } from './pdfTypes';

const DEPENDENCY_TABLES = [
  'messages', 'projects', 'research_relations', 'review_runs', 'review_campaigns',
  'embedding_vectors', 'embedding_manifests', 'external_claims', 'external_claim_links'
] as const;

function containsPinnedId(value: unknown, ids: Set<string>, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return ids.has(value);
  if (!value || typeof value !== 'object' || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some(item => containsPinnedId(item, ids, seen));
}

/** Deletes only an unused imported source. Historical evidence and project scopes block deletion. */
export async function deleteUnusedReference(
  sourceId: string,
  expectedHash: string,
  db: QaxiomDatabase = qaxiomDatabase
): Promise<{ source: ReferenceDocument; removedSpanCount: number; removedPdfAsset: boolean }> {
  if (!sourceId || !expectedHash) throw new Error('삭제할 자료의 ID와 hash를 다시 확인하세요.');
  const tables = [db.references, db.reference_spans, db.pdf_assets,
    ...DEPENDENCY_TABLES.map(name => db.table(name))];
  return db.transaction('rw', tables, async () => {
    const source = await db.references.get(sourceId);
    if (!source || source.contentHash !== expectedHash) throw new Error('자료가 변경되었거나 이미 삭제되었습니다. 목록을 다시 확인하세요.');
    const spans = await db.reference_spans.where('sourceId').equals(sourceId).toArray();
    const pinnedIds = new Set([source.id, ...spans.map(span => span.id)]);
    for (const name of DEPENDENCY_TABLES) {
      const rows = await db.table(name).toArray();
      if (rows.some(row => containsPinnedId(row, pinnedIds))) {
        throw new Error('이 자료는 과거 답변·검토·관계·프로젝트 범위 또는 색인에서 사용 중입니다. 근거 이력을 보존하기 위해 삭제할 수 없습니다.');
      }
    }

    let removedPdfAsset = false;
    if (source.pdf) {
      const asset = await db.pdf_assets.get(source.pdf.assetId);
      if (!asset || asset.fileHash !== source.pdf.fileHash || asset.status === 'running') {
        throw new Error('PDF 원본 상태가 변경되었습니다. 목록을 다시 확인하세요.');
      }
      const shared = await db.references.filter(item => item.id !== source.id && item.pdf?.assetId === asset.id).first();
      if (shared) throw new Error('PDF 원본을 다른 자료도 사용하므로 삭제할 수 없습니다.');
      await db.pdf_assets.delete(asset.id);
      removedPdfAsset = true;
    }
    await db.reference_spans.where('sourceId').equals(source.id).delete();
    await db.references.delete(source.id);
    return { source, removedSpanCount: spans.length, removedPdfAsset };
  });
}

/** Deletes a PDF asset only when extraction produced no reference or pinned history. */
export async function deleteUnlinkedPdfAsset(
  assetId: string,
  expectedFileHash: string,
  db: QaxiomDatabase = qaxiomDatabase
): Promise<{ name: string }> {
  if (!assetId || !expectedFileHash) throw new Error('삭제할 PDF 원본을 다시 확인하세요.');
  const candidate = await db.pdf_assets.get(assetId);
  if (!candidate || candidate.fileHash !== expectedFileHash) throw new Error('PDF 원본이 변경되었거나 이미 삭제되었습니다. 목록을 다시 확인하세요.');
  if (Object.prototype.toString.call(candidate.bytes) !== '[object ArrayBuffer]' || !candidate.bytes.byteLength) {
    throw new Error('PDF 원본 바이트가 손상되었습니다. 백업과 원본을 확인하세요.');
  }
  if (await hashBytes(candidate.bytes) !== candidate.fileHash) throw new Error('PDF 원본 hash가 일치하지 않습니다. 백업과 원본을 확인하세요.');
  const tables = [db.pdf_assets, db.references, db.reference_spans,
    ...DEPENDENCY_TABLES.map(name => db.table(name))];
  return db.transaction('rw', tables, async () => {
    const asset = await db.pdf_assets.get(assetId);
    if (!asset || asset.fileHash !== expectedFileHash) throw new Error('PDF 원본이 변경되었거나 이미 삭제되었습니다. 목록을 다시 확인하세요.');
    if (asset.status === 'running' || asset.runId !== null) throw new Error('처리 중인 PDF 원본은 삭제할 수 없습니다. 처리를 중단한 뒤 다시 시도하세요.');
    if (asset.bytes.byteLength !== candidate.bytes.byteLength) throw new Error('PDF 원본이 변경되었습니다. 목록을 다시 확인하세요.');
    if (await db.references.filter(source => source.pdf?.assetId === asset.id).first()
      || await db.reference_spans.where('sourceId').equals(`pdf-${asset.id}`).count()) {
      throw new Error('검색 자료 또는 추출 구간에 연결된 PDF 원본입니다. 자료의 근거 이력을 먼저 확인하세요.');
    }
    const pinnedIds = new Set([asset.id, `pdf-${asset.id}`, asset.fileHash]);
    for (const name of DEPENDENCY_TABLES) {
      const rows = await db.table(name).toArray();
      if (rows.some(row => containsPinnedId(row, pinnedIds))) {
        throw new Error('이 PDF 원본은 과거 기록에서 사용 중입니다. 근거 이력을 보존하기 위해 삭제할 수 없습니다.');
      }
    }
    await db.pdf_assets.delete(asset.id);
    return { name: asset.name };
  });
}
