import { openPdf, pdfEngineVersion } from './pdfRuntime';
import { MAX_PDF_PAGES, MAX_PDF_TEXT, type PdfPageText } from './pdfTypes';
import { textFromPdfItems } from './pdfLayout';

export interface PdfExtractionOptions {
  signal: AbortSignal;
  savedPages: PdfPageText[];
  engineVersion: string;
  onDocument: (count: number, version: string, reset: boolean) => Promise<void>;
  onPage: (page: PdfPageText) => Promise<void>;
}

export async function extractPdf(bytes: ArrayBuffer, options: PdfExtractionOptions) {
  options.signal.throwIfAborted();
  const task = openPdf(bytes);
  const abort = () => { void task.destroy().catch(() => {}); };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    const pdf = await task.promise;
    options.signal.throwIfAborted();
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`PDF는 ${MAX_PDF_PAGES}쪽 이하여야 합니다.`);
    const reset = options.engineVersion !== pdfEngineVersion;
    const saved = reset ? [] : options.savedPages;
    await options.onDocument(pdf.numPages, pdfEngineVersion, reset);
    let length = saved.reduce((sum, page) => sum + page.text.length, 0);
    for (let number = saved.length + 1; number <= pdf.numPages; number++) {
      options.signal.throwIfAborted();
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = textFromPdfItems(content.items.filter(item => 'str' in item));
      length += text.length;
      if (length > MAX_PDF_TEXT) throw new Error('추출 텍스트가 200만 자를 초과합니다. PDF를 나누어 등록해 주세요.');
      options.signal.throwIfAborted();
      await options.onPage({ number, text });
      page.cleanup();
    }
    options.signal.throwIfAborted();
  } finally {
    options.signal.removeEventListener('abort', abort);
    await task.destroy().catch(() => {});
  }
}
