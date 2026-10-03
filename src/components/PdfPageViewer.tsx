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
      if (!asset || await hashBytes(asset.bytes) !== asset.fileHash) throw new Error('PDF 원본이 없거나 해시가 일치하지 않습니다.');
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
    })().catch(cause => { if (active) { setError(cause instanceof Error ? cause.message : 'PDF 페이지를 표시하지 못했습니다.'); setLoading(false); } });
    return () => { active = false; render?.cancel(); void task?.destroy().catch(() => {}); };
  }, [assetId, pageNumber]);
  return <section aria-label="PDF 원본 페이지" className="pdf-page-viewer">
    <p>원본 {pageNumber}쪽{count ? ` / ${count}쪽` : ''} · 추출 순서·수식은 이 화면과 대조해 주세요. 좌표별 인용 강조는 아직 지원하지 않습니다.</p>
    <div className="pdf-page-actions">
      <button type="button" disabled={loading || pageNumber <= 1} onClick={() => setPageNumber(number => number - 1)}>이전 페이지</button>
      <button type="button" disabled={loading || pageNumber >= count} onClick={() => setPageNumber(number => number + 1)}>다음 페이지</button>
    </div>
    {loading && <p role="status">PDF 페이지 렌더링 중…</p>}
    {error && <p role="alert">{error}</p>}
    <canvas ref={canvas} aria-label={`PDF 원본 ${pageNumber}쪽`} hidden={loading || !!error} />
  </section>;
}
