import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { hashText } from '../theory/blocks';
import type { ReferenceRole, ReferenceDocument } from './types';
import { assemblePdfPages } from './pdfLayout';
import { syncReferenceToWiki } from '../wiki/wikiService';
import { hashBytes, MAX_PDF_BYTES, type PdfAsset } from './pdfTypes';
import type { PdfExtractionOptions } from './pdfExtraction';

export async function registerPdf(name: string, bytes: ArrayBuffer, role: ReferenceRole, db = qaxiomDatabase) {
  if (!/\.pdf$/i.test(name) || bytes.byteLength === 0 || bytes.byteLength > MAX_PDF_BYTES) throw new Error('PDF 파일은 0보다 크고 20 MB 이하여야 합니다.');
  if (!['external', 'note', 'theory_snapshot'].includes(role)) throw new Error('문서 종류가 올바르지 않습니다.');
  const fileHash = await hashBytes(bytes);
  return db.transaction('rw', db.pdf_assets, async () => {
    const existing = await db.pdf_assets.where('fileHash').equals(fileHash).first();
    if (existing) {
      if (existing.role !== role) throw new Error('같은 PDF가 다른 문서 종류로 등록되어 있습니다. 출처를 확인해 주세요.');
      return { asset: existing, duplicate: true };
    }
    const asset: PdfAsset = {
      id: crypto.randomUUID(), name, bytes, role, fileHash, createdAt: Date.now(),
      status: 'pending', runId: null, pageCount: 0, pages: [], engineVersion: '', error: ''
    };
    await db.pdf_assets.add(asset);
    return { asset, duplicate: false };
  });
}

type Extractor = (bytes: ArrayBuffer, options: PdfExtractionOptions) => Promise<void>;
export async function processPdf(
  assetId: string, signal: AbortSignal, onProgress: (asset: PdfAsset) => void,
  db: QaxiomDatabase = qaxiomDatabase,
  extractor: Extractor = async (bytes, options) => (await import('./pdfExtraction')).extractPdf(bytes, options)
) {
  const runId = crypto.randomUUID();
  const initial = await db.transaction('rw', db.pdf_assets, async () => {
    const row = await db.pdf_assets.get(assetId);
    if (!row) throw new Error('PDF 원본이 없습니다.');
    if (['ready', 'partial', 'ocr_required'].includes(row.status)) return row;
    const running = { ...row, status: 'running' as const, runId, error: '' };
    await db.pdf_assets.put(running); return running;
  });
  if (initial.runId !== runId) return initial;
  const update = async (mutate: (row: PdfAsset) => PdfAsset) => db.transaction('rw', db.pdf_assets, async () => {
    const row = await db.pdf_assets.get(assetId);
    if (!row || row.runId !== runId) throw new Error('다른 작업이 PDF 처리를 이어받았습니다.');
    signal.throwIfAborted();
    const next = mutate(row); await db.pdf_assets.put(next); onProgress(next); return next;
  });
  onProgress(initial);
  try {
    await extractor(initial.bytes, {
      signal, savedPages: initial.pages, engineVersion: initial.engineVersion,
      onDocument: async (pageCount, engineVersion, reset) => { await update(row => ({ ...row, pageCount, engineVersion, pages: reset ? [] : row.pages })); },
      onPage: async page => { await update(row => {
        if (page.number !== row.pages.length + 1 || page.number > row.pageCount) throw new Error('PDF 페이지 순서가 올바르지 않습니다.');
        return { ...row, pages: [...row.pages, page] };
      }); }
    });
    signal.throwIfAborted();
    const completed = await db.pdf_assets.get(assetId);
    if (!completed || completed.runId !== runId || !completed.pageCount || completed.pages.length !== completed.pageCount) throw new Error('PDF 추출이 끝나지 않았습니다.');
    const assembled = assemblePdfPages(completed.pages);
    const contentHash = await hashText(assembled.text);
    const sourceId = `pdf-${assetId}`;
    const spans = await Promise.all(assembled.spans.map(async (span, position) => ({
      ...span, id: crypto.randomUUID(), sourceId, position, contentHash: await hashText(span.text)
    })));
    const empty = assembled.locations.filter(page => page.status === 'empty').length;
    const status = empty === completed.pageCount ? 'ocr_required' : empty ? 'partial' : 'ready';
    const txResult = await db.transaction('rw', [db.pdf_assets, db.references, db.reference_spans, db.document_versions], async () => {
      signal.throwIfAborted();
      if ((await db.pdf_assets.get(assetId))?.runId !== runId) throw new Error('다른 작업이 PDF 처리를 이어받았습니다.');
      if (status !== 'ocr_required') {
        const own = await db.document_versions.where('contentHash').equals(contentHash).first();
        const source: ReferenceDocument = {
          id: sourceId, name: completed.name, text: assembled.text, contentHash,
          role: own ? 'theory_snapshot' : completed.role, originVersionId: own?.id || null,
          createdAt: completed.createdAt, parserVersion: 'pdfjs-v1',
          pdf: { assetId, fileHash: completed.fileHash, pageCount: completed.pageCount, engineVersion: completed.engineVersion, pages: assembled.locations }
        };
        await db.references.add(source);
        await db.reference_spans.bulkAdd(spans);
      }
      const result: PdfAsset = { ...completed, status, runId: null,
        error: empty ? `텍스트 없는 페이지 ${empty}개는 검색에서 제외됩니다. 검색 가능한 텍스트/Markdown 또는 텍스트 계층이 있는 PDF를 준비해 주세요. 빈 페이지일 수도 있습니다.` : '' };
      await db.pdf_assets.put(result); onProgress(result); return result;
    });
    if (status !== 'ocr_required' && db.tables?.some(t => t.name === 'wiki_pages')) {
      try {
        const source = await db.references.get(sourceId);
        if (source) await syncReferenceToWiki(source, db);
      } catch { }
    }
    return txResult;
  } catch (cause) {
    const status = signal.aborted ? 'cancelled' : cause instanceof Error && cause.name === 'PasswordException' ? 'encrypted' : 'failed';
    const error = status === 'cancelled' ? '추출을 중단했습니다. 완료한 페이지부터 재개할 수 있습니다.'
      : status === 'encrypted' ? '암호화 PDF입니다. 암호를 해제한 사본을 등록해 주세요. 암호는 저장하지 않습니다.'
        : cause instanceof Error ? cause.message : 'PDF를 해석하지 못했습니다.';
    const result = await db.transaction('rw', db.pdf_assets, async () => {
      const row = await db.pdf_assets.get(assetId);
      if (!row || row.runId !== runId) throw cause;
      const failed: PdfAsset = { ...row, status, runId: null, error };
      await db.pdf_assets.put(failed); return failed;
    });
    onProgress(result); return result;
  }
}
