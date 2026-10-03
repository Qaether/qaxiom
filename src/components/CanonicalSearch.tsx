import { useEffect, useRef, useState } from 'react';
import type { TheorySnapshot } from '../services/theory/types';
import { describeCanonicalCandidates, type CanonicalCandidate } from '../services/retrieval/canonicalCandidates';
import type { CanonicalHit } from '../services/retrieval/canonicalRanking';

export default function CanonicalSearch({ snapshot, query, selected, onSelect }: {
  snapshot: TheorySnapshot; query: string; selected: string[]; onSelect: (id: string) => void;
}) {
  const [candidates, setCandidates] = useState<CanonicalCandidate[]>([]);
  const [busy, setBusy] = useState(false), [searched, setSearched] = useState(false), [error, setError] = useState('');
  const worker = useRef<Worker | null>(null), controller = useRef<AbortController | null>(null), timer = useRef<number | undefined>(undefined);
  const cancel = () => { controller.current?.abort(); worker.current?.terminate(); worker.current = null; window.clearTimeout(timer.current); setBusy(false); };
  useEffect(() => () => { controller.current?.abort(); worker.current?.terminate(); window.clearTimeout(timer.current); }, []);
  const search = () => {
    cancel(); setCandidates([]); setSearched(false); setError(''); setBusy(true);
    const abort = new AbortController(); controller.current = abort;
    const fail = (message: string) => { if (abort.signal.aborted) return; cancel(); setError(message); };
    timer.current = window.setTimeout(() => fail('정본 검색이 30초 한도를 넘었습니다. 자동 재시도하지 않습니다.'), 30000);
    try {
      const engine = new Worker(new URL('../services/retrieval/canonical.worker.ts', import.meta.url), { type: 'module' }); worker.current = engine;
      engine.onmessage = (event: MessageEvent<{ hits?: CanonicalHit[]; error?: string }>) => {
        engine.terminate(); worker.current = null;
        if (event.data.error || !event.data.hits) { fail(event.data.error ?? '정본 후보 응답이 없습니다.'); return; }
        void describeCanonicalCandidates(snapshot, event.data.hits, undefined, abort.signal).then(result => {
          if (abort.signal.aborted) return; window.clearTimeout(timer.current); setCandidates(result); setSearched(true); setBusy(false);
        }).catch(cause => { if (!abort.signal.aborted) fail(cause instanceof Error ? cause.message : '정본 후보 확인 실패'); });
      };
      engine.onerror = () => fail('정본 검색 Worker 실행에 실패했습니다.');
      engine.postMessage({ blocks: snapshot.blocks, query });
    } catch (cause) { fail(cause instanceof Error ? cause.message : '정본 검색 실패'); }
  };
  return <section aria-label="정본 목표 후보">
    <p>선택 정본에서 질문 용어로 BM25 후보를 찾고 승인된 전제·정의 범위를 확인합니다. 외부 자료/다른 정본은 검색하지 않습니다. 점수는 의미적 지지나 정합성 확률이 아니며 후보를 자동 선택·전송하지 않습니다.</p>
    <button type="button" disabled={busy || !query.trim() || query.length > 2000} onClick={search}>질문으로 정본 목표 후보 찾기</button>
    {busy && <><p role="status">정본 후보/승인 전제 확인 중…</p><button type="button" onClick={() => { cancel(); setError('정본 검색을 중단했습니다.'); }}>정본 후보 검색 중단</button></>}
    {error && <p role="alert">{error}</p>}
    {searched && !candidates.length && <p>일치하는 정본 용어가 없습니다. 용어를 바꾸거나 아래에서 목표를 직접 선택하세요. 관련 관계가 없다는 판정은 아닙니다.</p>}
    {candidates.map(candidate => <article key={candidate.block.id} aria-label={`정본 후보 블록 ${candidate.block.position + 1}`}>
      <p>블록 {candidate.block.position + 1} · BM25 {candidate.score.toFixed(3)} · {candidate.error ? '연결 범위 미확인' : `추가 전제 ${candidate.premiseBlockIds.length} · 승인 관계 ${candidate.relationCount} · proof 순환 후보 ${candidate.proofCycleCount} · 외부 관계 미전송 ${candidate.excludedExternalCount}`}</p>
      <pre>{candidate.block.text}</pre>
      {candidate.error && <p role="alert">{candidate.error}</p>}
      <button type="button" disabled={!!candidate.error} onClick={() => onSelect(candidate.block.id)}>{selected.includes(candidate.block.id) ? '후보 목표 선택 해제' : '이 후보를 목표에 추가'}</button>
      <p>추가 전제는 최종 원문 미리보기에서 확인하세요. 선택 후 변경된 정본/관계는 전송 전에 다시 검사합니다.</p>
    </article>)}
  </section>;
}
