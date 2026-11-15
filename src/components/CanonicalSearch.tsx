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
    timer.current = window.setTimeout(() => fail('Canonical search exceeded the 30-second limit. It will not retry automatically.'), 30000);
    try {
      const engine = new Worker(new URL('../services/retrieval/canonical.worker.ts', import.meta.url), { type: 'module' }); worker.current = engine;
      engine.onmessage = (event: MessageEvent<{ hits?: CanonicalHit[]; error?: string }>) => {
        engine.terminate(); worker.current = null;
        if (event.data.error || !event.data.hits) { fail(event.data.error ?? 'No canonical candidate response received.'); return; }
        void describeCanonicalCandidates(snapshot, event.data.hits, undefined, abort.signal).then(result => {
          if (abort.signal.aborted) return; window.clearTimeout(timer.current); setCandidates(result); setSearched(true); setBusy(false);
        }).catch(cause => { if (!abort.signal.aborted) fail(cause instanceof Error ? cause.message : 'Failed to verify canonical candidates.'); });
      };
      engine.onerror = () => fail('Failed to run the canonical search worker.');
      engine.postMessage({ blocks: snapshot.blocks, query });
    } catch (cause) { fail(cause instanceof Error ? cause.message : 'Canonical search failed.'); }
  };
  return <section aria-label="Canonical Target Candidates">
    <p>Finds BM25 candidates in the selected canonical document using query terms and checks approved premise/definition scopes. External sources and other canonical documents are not searched. Scores do not represent semantic support or consistency probability, and candidates are not auto-selected or sent.</p>
    <button type="button" disabled={busy || !query.trim() || query.length > 2000} onClick={search}>Find Canonical Target Candidates</button>
    {busy && <><p role="status">Checking canonical candidates and approved premises…</p><button type="button" onClick={() => { cancel(); setError('Canonical search was cancelled.'); }}>Cancel Candidate Search</button></>}
    {error && <p role="alert">{error}</p>}
    {searched && !candidates.length && <p>No matching canonical terms found. Try different terms or select a target manually below. This does not mean no relation exists.</p>}
    {candidates.map(candidate => <article key={candidate.block.id} aria-label={`Canonical candidate block ${candidate.block.position + 1}`}>
      <p>Block {candidate.block.position + 1} · BM25 {candidate.score.toFixed(3)} · Extra premises {candidate.premiseBlockIds.length} · Approved relations {candidate.relationCount} · Proof cycle candidates {candidate.proofCycleCount} · Excluded external relations {candidate.excludedExternalCount}</p>
      <pre>{candidate.block.text}</pre>
      <button type="button" onClick={() => onSelect(candidate.block.id)}>{selected.includes(candidate.block.id) ? 'Deselect Candidate Target' : 'Add Candidate to Targets'}</button>
      <p>Review additional premises in the final source preview. Any canonical document or relation changes after selection will be re-checked before sending.</p>
    </article>)}
  </section>;
}
