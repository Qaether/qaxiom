import { useEffect, useRef } from 'react';
import PdfPageViewer from './PdfPageViewer';

export default function PdfOriginal({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className="reference-dialog" aria-labelledby="pdf-original-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id="pdf-original-title">PDF 원본: {name}</h2><button type="button" onClick={onClose}>닫기</button></header>
    <PdfPageViewer assetId={id} />
  </dialog>;
}
