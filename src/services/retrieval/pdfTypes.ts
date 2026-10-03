export type PdfStatus = 'pending' | 'running' | 'ready' | 'partial' | 'ocr_required' | 'encrypted' | 'failed' | 'cancelled';
export interface PdfPageText { number: number; text: string }
export interface PdfAsset {
  id: string;
  name: string;
  fileHash: string;
  bytes: ArrayBuffer;
  role: 'external' | 'note' | 'theory_snapshot';
  createdAt: number;
  status: PdfStatus;
  runId: string | null;
  pageCount: number;
  pages: PdfPageText[];
  engineVersion: string;
  error: string;
}
export interface PdfAssetBackup extends Omit<PdfAsset, 'bytes'> { base64: string }
export interface PdfSourceInfo {
  assetId: string;
  fileHash: string;
  pageCount: number;
  engineVersion: string;
  pages: { number: number; startOffset: number; endOffset: number; status: 'text' | 'empty' }[];
}
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 300;
export const MAX_PDF_TEXT = 2_000_000;

export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function spanLocation(span: { page?: number; startLine: number; endLine: number }) {
  return `${span.page ? `${span.page}쪽 · ` : ''}${span.startLine}–${span.endLine}행`;
}
