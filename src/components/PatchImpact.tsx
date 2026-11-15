import { useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { currentPatchImpactScope, patchContentHash, preparePatchImpact, type PatchImpact as Impact } from '../services/theory/patchImpact';
import type { ReviewRun, TheoryPatch } from '../services/theory/reviewTypes';
import { checkerCovers } from '../services/theory/reviewTypes';
import type { DocumentBlock, TheorySnapshot } from '../services/theory/types';
import { prepareUndeclaredImpact, rankImpactInWorker, selectUndeclaredImpact, type UndeclaredImpact } from '../services/theory/undeclaredImpact';

export default function PatchImpact({ run, patch, snapshot, runs, disabled, onApply, onSelect }: {
  run: ReviewRun; patch: TheoryPatch; snapshot: TheorySnapshot; runs: ReviewRun[]; disabled: boolean;
  onApply: (impact: Impact) => void; onSelect: (blockIds: string[]) => void;
}) {
  const [preview, setPreview] = useState<{ impact: Impact; blocks: DocumentBlock[] } | null>(null);
  const [scope, setScope] = useState<Awaited<ReturnType<typeof currentPatchImpactScope>> | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [candidates, setCandidates] = useState<UndeclaredImpact | null>(null);
  const [chosen, setChosen] = useState<string[]>([]), [nominated, setNominated] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const impact = patch.impact ?? preview?.impact;
  const inspect = async () => {
    setBusy(true); setError(''); setPreview(null);
    try {
      const value = patch.appliedVersionId ? patch.impact : (await preparePatchImpact(run.id, patch.id)).impact;
      if (!value) throw new Error('Legacy patch format has no impact history. Please re-check the full document.');
      if (await patchContentHash(run, patch) !== value.patchHash) throw new Error('Patch diff has changed. Please review the latest suggestion again.');
      const ids = [...value.graph.targetBlockIds, ...value.graph.premiseBlockIds];
      const blocks = await qaxiomDatabase.document_blocks.where('versionId').equals(run.versionId).sortBy('position');
      setPreview({ impact: value, blocks: blocks.filter(b => ids.includes(b.id)) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to inspect impact scope'); }
    finally { setBusy(false); }
  };
  const select = async () => {
    setBusy(true); setError(''); setScope(null); setCandidates(null); setChosen([]); setNominated([]);
    try { const value = await currentPatchImpactScope(run.id, patch.id, snapshot); setScope(value); onSelect(value.blockIds); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to select re-check scope'); }
    finally { setBusy(false); }
  };
  const checked = new Set(runs.filter(r => r.versionId === snapshot.version.id && r.status === 'complete' && checkerCovers(run.checker, r.checker)).flatMap(r => r.checkedBlockIds));
  const currentCandidates = candidates?.versionId === snapshot.version.id ? candidates : null;
  const searchCandidates = async () => {
    setBusy(true); setSearching(true); setError(''); setCandidates(null); setChosen([]); setNominated([]);
    const abort = new AbortController(); controller.current = abort;
    try {
      const result = await prepareUndeclaredImpact(run.id, patch.id, snapshot, qaxiomDatabase, input => rankImpactInWorker(input, abort.signal));
      abort.signal.throwIfAborted(); setCandidates(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to search undeclared impact candidates'); }
    finally { setBusy(false); setSearching(false); controller.current = null; }
  };
  const nominate = async () => {
    if (!currentCandidates) return;
    setBusy(true); setError(''); setNominated([]);
    try {
      const ids = await selectUndeclaredImpact(run.id, patch.id, snapshot, currentCandidates, chosen);
      setScope(null); setNominated(ids); onSelect(ids);
    } catch (cause) { setCandidates(null); setChosen([]); setError(cause instanceof Error ? cause.message : 'Failed to select candidate scope'); }
    finally { setBusy(false); }
  };
  return <section aria-label="Patch impact scope">
    <p>These are impact candidates declared in approved relations; completeness for undeclared relations is unverified. Past approvals are not carried over as active relations in the new version.</p>
    <button type="button" disabled={disabled || busy || !patch.appliedVersionId && run.versionId !== snapshot.version.id} onClick={() => void inspect()}>Inspect patch impact scope</button>
    {impact && <p>Pre-apply targets: {impact.graph.targetBlockIds.length} blocks · Additional premises: {impact.graph.premiseBlockIds.length} blocks · {impact.graph.relationSnapshots.length} relations · {impact.contractChanged ? 'New assumptions — full document re-check candidate' : 'Approved dependency/definition backlinks and support/conflict candidates'} · Excluded external sources: {impact.graph.excludedCounts.external_not_selected}</p>}
    {preview && <details open><summary>Impact candidate source text &amp; pre-apply approval history</summary>
      {preview.blocks.map(b => <div key={b.id}><p>{preview.impact.graph.targetBlockIds.includes(b.id) ? 'Impact target' : 'Required premise'} · Block {b.position + 1} · {b.id} · {b.contentHash}</p><pre>{b.text}</pre></div>)}
      <pre>{JSON.stringify(preview.impact, null, 2)}</pre>
    </details>}
    {!patch.appliedVersionId && <button type="button" disabled={disabled || busy || !preview || run.versionId !== snapshot.version.id} onClick={() => {
      if (!preview || !window.confirm('Have you reviewed the patch diff, new assumptions, and impact scope? This creates a new version; issue resolution must be confirmed separately after re-checking.')) return;
      onApply(preview.impact);
    }}>Approve patch diff &amp; save new version</button>}
    {patch.appliedVersionId && <p>{patch.issueIds.every(id => run.issues.find(i => i.id === id)?.resolvedByRunId) ? 'Applied — user-confirmed resolved' : 'Applied — re-check verification required'} · {patch.appliedVersionId}</p>}
    {patch.appliedVersionId && patch.impact && <button type="button" disabled={disabled || busy} onClick={() => void select()}>Select patch-impact re-check scope for current version</button>}
    {scope && scope.versionId === snapshot.version.id && <p>Current version re-check candidates: {scope.blockIds.length} blocks · Checked: {scope.blockIds.filter(id => checked.has(id)).length}/{scope.blockIds.length}. {scope.fullScope && 'Full scope selected due to criteria change or missing lineage.'} Selecting a scope does not transmit or complete a check. Past graphs are not attached to requests; preview and approve the new source text. Existing full-scope re-check conditions still apply for issue resolution.</p>}
    {patch.appliedVersionId && patch.impact && <section aria-label="Undeclared patch impact candidates">
      <p>Locally searches for blocks outside the approved impact scope that share terms or symbols before and after the patch. Uses NFKC lowercase and 2-character Hangul lexical matching—not semantic dependency or formula equivalence checking. Finding no candidates does not prove zero impact or consistency.</p>
      <button type="button" disabled={disabled || busy} onClick={() => void searchCandidates()}>Find undeclared patch impact candidates</button>
      {searching && <button type="button" onClick={() => controller.current?.abort()}>Cancel candidate search</button>}
      {currentCandidates && <>
        <p>Existing scope: {currentCandidates.scopeBlockIds.length} blocks · Scanned outside scope: {currentCandidates.ranking.scannedBlockCount} blocks · Shown candidates: {currentCandidates.ranking.matches.length} · Omitted matches: {currentCandidates.ranking.omittedMatchCount}. Up to 24 shown; omitted or unmatched source text is not sent automatically. If full scope is needed, select it directly from the review list.</p>
        <details><summary>Pre/post-patch search terms</summary><pre>{JSON.stringify(currentCandidates.ranking.terms, null, 2)}</pre></details>
        {currentCandidates.ranking.matches.map(match => {
          const block = snapshot.blocks.find(b => b.id === match.blockId)!;
          return <div key={block.id}><label><input type="checkbox" aria-label={`Undeclared candidate block ${block.position + 1}`} disabled={disabled || busy} checked={chosen.includes(block.id)} onChange={e => { setNominated([]); setChosen(e.target.checked ? [...chosen, block.id] : chosen.filter(id => id !== block.id)); }} />Block {block.position + 1} · {block.id}</label>
            <p>Removed term matches: {match.removed.join(', ') || 'None'} · Added term matches: {match.added.join(', ') || 'None'} · Retained term matches: {match.retained.join(', ') || 'None'}</p><pre>{block.text}</pre></div>;
        })}
        <button type="button" disabled={disabled || busy || !chosen.length} onClick={() => void nominate()}>Set selected candidates + existing impact scope for re-check</button>
        {!!nominated.length && <p>Explicitly selected: {nominated.length} blocks · Checked: {nominated.filter(id => checked.has(id)).length}/{nominated.length}. Current approved premises are also included. No automatic relation approval, API transmission, or issue resolution occurs. Check the new transmission preview. Candidate search/selection is transient and resets on reload.</p>}
      </>}
    </section>}
    {busy && <p role="status">Checking impact scope…</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
