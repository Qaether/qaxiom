import { hashBytes, MAX_PDF_BYTES, MAX_PDF_PAGES, MAX_PDF_TEXT, type PdfAsset, type PdfAssetBackup } from './pdfTypes';

export function encodePdfAsset(asset: PdfAsset): PdfAssetBackup {
  const { bytes, ...metadata } = asset;
  if (!bytes || !Number.isSafeInteger(bytes.byteLength) || !bytes.byteLength || bytes.byteLength > MAX_PDF_BYTES) throw new Error('PDF 원본 바이트가 손상되어 백업할 수 없습니다.');
  const array = new Uint8Array(bytes);
  let binary = '';
  for (let start = 0; start < array.length; start += 8192) binary += String.fromCharCode(...array.subarray(start, start + 8192));
  return { ...metadata, base64: btoa(binary) };
}

export function decodePdfAsset(value: unknown): PdfAsset {
  const fail = (): never => { throw new Error('PDF 백업의 원본·페이지·처리 상태가 올바르지 않습니다.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  for (const key of ['id', 'name', 'fileHash', 'base64']) if (typeof row[key] !== 'string' || !row[key]) fail();
  if (typeof row.base64 !== 'string' || row.base64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4
    || row.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(row.base64)) return fail();
  let binary: string;
  try { binary = atob(row.base64); } catch { return fail(); }
  if (btoa(binary) !== row.base64 || !binary.length || binary.length > MAX_PDF_BYTES) fail();
  if (!['external', 'note', 'theory_snapshot'].includes(String(row.role))
    || !['pending', 'running', 'ready', 'partial', 'ocr_required', 'encrypted', 'failed', 'cancelled'].includes(String(row.status))
    || !Number.isSafeInteger(row.pageCount) || Number(row.pageCount) < 0 || Number(row.pageCount) > MAX_PDF_PAGES
    || !Number.isSafeInteger(row.createdAt) || Number(row.createdAt) < 0
    || typeof row.engineVersion !== 'string' || typeof row.error !== 'string'
    || (row.runId !== null && typeof row.runId !== 'string') || !Array.isArray(row.pages)) return fail();
  const pages = row.pages.map((page: unknown, index: number) => {
    if (!page || typeof page !== 'object' || Array.isArray(page)) return fail();
    const part = page as Record<string, unknown>;
    if (part.number !== index + 1 || typeof part.text !== 'string') return fail();
    return { number: index + 1, text: part.text };
  });
  if (pages.length > Number(row.pageCount) || pages.reduce((sum, page) => sum + page.text.length, 0) > MAX_PDF_TEXT) fail();
  if (pages.length && !row.engineVersion) fail();
  if (['ready', 'partial', 'ocr_required'].includes(String(row.status))) {
    if (!pages.length || pages.length !== row.pageCount) fail();
    const empty = pages.filter(page => !page.text.trim()).length;
    if (row.status !== (empty === pages.length ? 'ocr_required' : empty ? 'partial' : 'ready')) fail();
  }
  return {
    id: String(row.id), name: String(row.name), fileHash: String(row.fileHash), bytes: Uint8Array.from(binary, char => char.charCodeAt(0)).buffer,
    role: row.role as PdfAsset['role'], createdAt: Number(row.createdAt),
    // A restored browser cannot own a job from another profile.
    status: row.status === 'running' ? 'cancelled' : row.status as PdfAsset['status'], runId: null,
    pageCount: Number(row.pageCount), pages, engineVersion: row.engineVersion, error: row.error
  };
}

export function parsePdfAssets(value: unknown): PdfAsset[] {
  if (!Array.isArray(value)) throw new Error('PDF 원본 목록이 올바르지 않습니다.');
  const assets = value.map(decodePdfAsset);
  if (new Set(assets.map(asset => asset.id)).size !== assets.length || new Set(assets.map(asset => asset.fileHash)).size !== assets.length) throw new Error('중복 PDF 원본입니다.');
  return assets;
}

export async function verifyPdfAssets(assets: PdfAsset[]) {
  for (const asset of assets) if (await hashBytes(asset.bytes) !== asset.fileHash) throw new Error('PDF 원본 해시가 일치하지 않습니다.');
}
