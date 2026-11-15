import { useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { hashBytes } from '../services/retrieval/pdfTypes';
import type { PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';

export default function PdfPageViewer({ assetId, initialPage = 1 }: { assetId: string; initialPage?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pageNumber, setPageNumber] = useState(initialPage);
  const [count, setCount] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    let render: RenderTask | undefined;
    void (async () => {
      setLoading(true); setError('');
      const asset = await qaxiomDatabase.pdf_assets.get(assetId);
      if (!asset || await hashBytes(asset.bytes) !== asset.fileHash) throw new Error('The original PDF is missing or its hash does not match.');
      const { openPdf } = await import('../services/retrieval/pdfRuntime');
      if (!active) return;
      task = openPdf(asset.bytes);
      const pdf = await task.promise;
      if (!active) return;
      setCount(pdf.numPages);
      const page = await pdf.getPage(pageNumber);
      if (!active) return;
      const native = page.getViewport({ scale: 1 });
      const scale = Math.min(1.5, 1000 / native.width, Math.sqrt(4_000_000 / (native.width * native.height)));
      const viewport = page.getViewport({ scale });
      const element = canvas.current!;
      element.width = Math.ceil(viewport.width); element.height = Math.ceil(viewport.height);
      render = page.render({ canvas: element, viewport, annotationMode: 0 });
      await render.promise;
      if (active) setLoading(false);
    })().catch(cause => { if (active) { setError(cause instanceof Error ? cause.message : 'Failed to display the PDF page.'); setLoading(false); } });
    return () => { active = false; render?.cancel(); void task?.destroy().catch(() => {}); };
  }, [assetId, pageNumber]);
  return <section aria-label="Original PDF Page" className="pdf-page-viewer">
    <p>Original page {pageNumber}{count ? ` / ${count}` : ''} · Please verify extraction order and formulas against this view. Coordinate-based citation highlighting is not yet supported.</p>
    <div className="pdf-page-actions">
      <button type="button" disabled={loading || pageNumber <= 1} onClick={() => setPageNumber(number => number - 1)}>Previous Page</button>
      <button type="button" disabled={loading || pageNumber >= count} onClick={() => setPageNumber(number => number + 1)}>Next Page</button>
    </div>
    {loading && <p role="status">Rendering PDF page…</p>}
    {error && <p role="alert">{error}</p>}
    <canvas ref={canvas} aria-label={`Original PDF page ${pageNumber}`} hidden={loading || !!error} />
  </section>;
}
