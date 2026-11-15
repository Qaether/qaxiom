import { useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { hashText } from '../services/theory/blocks';
import type { ContextEvidence } from '../services/retrieval/types';
import { spanLocation } from '../services/retrieval/pdfTypes';
import PdfPageViewer from './PdfPageViewer';
import './References.css';

export default function ReferenceSource({ evidence, onClose }: { evidence: ContextEvidence; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mark = useRef<HTMLElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pdfAssetId, setPdfAssetId] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current!; element.showModal();
    let active = true;
    void (async () => {
      const source = await qaxiomDatabase.references.get(evidence.sourceId);
      if (!source || await hashText(source.text) !== evidence.sourceHash
        || source.pdf?.fileHash !== evidence.pdf?.fileHash
        || source.text.slice(evidence.span.startOffset, evidence.span.endOffset) !== evidence.span.text) {
        throw new Error('The source text for this version is missing or has changed. Displaying the saved citation excerpt only.');
      }
      if (active) { setText(source.text); setPdfAssetId(source.pdf?.assetId || null); }
    })().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Failed to load the source text.'); });
    return () => { active = false; element.close(); };
  }, [evidence]);
  useEffect(() => { if (text !== null) mark.current?.scrollIntoView({ block: 'center' }); }, [text]);
  return <dialog ref={dialog} className="reference-dialog" aria-labelledby="source-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><h2 id="source-title">Cited Source: {evidence.name}</h2><p>[[{evidence.citationId}]] · {spanLocation(evidence.span)} · SHA-256 {evidence.sourceHash.slice(0, 12)}</p></div><button type="button" onClick={onClose}>Close</button></header>
    {error && <><p role="alert">{error}</p><pre>{evidence.span.text}</pre></>}
    {text === null && !error && <p role="status">Loading source text…</p>}
    {text !== null && <pre aria-label="Full Reference Source">{text.slice(0, evidence.span.startOffset)}<mark ref={mark}>{text.slice(evidence.span.startOffset, evidence.span.endOffset)}</mark>{text.slice(evidence.span.endOffset)}</pre>}
    {pdfAssetId && <PdfPageViewer assetId={pdfAssetId} initialPage={evidence.span.page} />}
  </dialog>;
}
