import { getDocument, GlobalWorkerOptions, version } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
export const pdfEngineVersion = version;
export function openPdf(bytes: ArrayBuffer) {
  const base = `${import.meta.env.BASE_URL}pdfjs/`;
  return getDocument({
    // PDF.js transfers its buffer to the worker. Keep the saved original intact.
    data: new Uint8Array(bytes.slice(0)),
    stopAtErrors: true, enableXfa: false,
    cMapUrl: `${base}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`,
    maxImageSize: 16_000_000, canvasMaxAreaInBytes: 64_000_000
  });
}
