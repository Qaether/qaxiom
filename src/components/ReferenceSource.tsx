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
        throw new Error('해당 버전의 원문이 없거나 변경되었습니다. 저장된 인용 발췌만 표시합니다.');
      }
      if (active) { setText(source.text); setPdfAssetId(source.pdf?.assetId || null); }
    })().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '원문을 읽지 못했습니다.'); });
    return () => { active = false; element.close(); };
  }, [evidence]);
  useEffect(() => { if (text !== null) mark.current?.scrollIntoView({ block: 'center' }); }, [text]);
  return <dialog ref={dialog} className="reference-dialog" aria-labelledby="source-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><h2 id="source-title">인용 원문: {evidence.name}</h2><p>[[{evidence.citationId}]] · {spanLocation(evidence.span)} · SHA-256 {evidence.sourceHash.slice(0, 12)}</p></div><button type="button" onClick={onClose}>닫기</button></header>
    {error && <><p role="alert">{error}</p><pre>{evidence.span.text}</pre></>}
    {text === null && !error && <p role="status">원문 불러오는 중…</p>}
    {text !== null && <pre aria-label="레퍼런스 전체 원문">{text.slice(0, evidence.span.startOffset)}<mark ref={mark}>{text.slice(evidence.span.startOffset, evidence.span.endOffset)}</mark>{text.slice(evidence.span.endOffset)}</pre>}
    {pdfAssetId && <PdfPageViewer assetId={pdfAssetId} initialPage={evidence.span.page} />}
  </dialog>;
}
