import { useState } from 'react';
import { prepareExternalRelation, approveExternalRelation, type ExternalRelationPreview } from '../services/theory/externalRelation';
import { COMPATIBILITY_LABELS, type CompatibilityAssessment } from '../services/theory/relationTypes';
import type { ReviewRun } from '../services/theory/reviewTypes';
import type { TheorySnapshot } from '../services/theory/types';

export default function ExternalRelationApproval({ run, pairId, snapshot, runs, disabled, onChanged }: {
  run: ReviewRun; pairId: string; snapshot: TheorySnapshot; runs: ReviewRun[]; disabled: boolean; onChanged: () => Promise<void>;
}) {
  const [claimKey, setClaim] = useState(''), [kind, setKind] = useState(''), [label, setLabel] = useState('');
  const [theoryConditions, setTheoryConditions] = useState(''), [referenceConditions, setReferenceConditions] = useState(''), [note, setNote] = useState('');
  const [preview, setPreview] = useState<{ key: string; value: ExternalRelationPreview } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const pair = run.external!.context.pairs.find(p => p.id === pairId)!;
  const assessment = run.external!.assessments.find(a => a.pairId === pairId)!;
  const claims = runs.filter(r => r.status === 'complete' && r.versionId === snapshot.version.id).flatMap(r => r.claims.filter(c => c.acceptance === 'accepted' && c.blockId === pair.blockId && c.statement.includes(assessment.theoryQuote)).map(c => ({ run: r, claim: c, key: JSON.stringify([r.id, c.id]) })));
  const key = JSON.stringify([snapshot.version.id, claimKey, kind, label, theoryConditions, referenceConditions, note]);
  const visible = preview?.key === key ? preview.value : null;
  const execute = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setStatus('');
    try { await action(); } catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : 'Failed to approve external comparison relation'); }
    finally { setBusy(false); }
  };
  return <section aria-label="Approve external comparison relation">
    <p>Review the currently accepted claim, source text, and conditions to approve a relation independently of the model suggestion. If no accepted claim includes the comparison quote, accept a claim candidate first. This does not automatically extract external claims or verify internal consistency.</p>
    <fieldset disabled={disabled || busy || run.versionId !== snapshot.version.id}>
      <label>Accepted claim to link with comparison<select aria-label="Accepted claim to link with comparison" value={claimKey} onChange={e => setClaim(e.target.value)}><option value="">Select explicitly</option>{claims.map(c => <option key={c.key} value={c.key}>{c.claim.statement}</option>)}</select></label>
      <label>Comparison relation type<select value={kind} onChange={e => setKind(e.target.value)}><option value="">Select explicitly</option><option value="supports">Support candidate</option><option value="contradicts">Conflict candidate</option></select></label>
      <label>User comparison judgment<select value={label} onChange={e => setLabel(e.target.value)}><option value="">Select independently of model classification</option>{COMPATIBILITY_LABELS.map(l => <option key={l}>{l}</option>)}</select></label>
      <label>Theory conditions to approve<textarea value={theoryConditions} maxLength={2000} onChange={e => setTheoryConditions(e.target.value)} /></label>
      <label>Source text conditions to approve<textarea value={referenceConditions} maxLength={2000} onChange={e => setReferenceConditions(e.target.value)} /></label>
      <label>Reason for approving comparison relation<textarea value={note} maxLength={2000} onChange={e => setNote(e.target.value)} /></label>
      <button type="button" disabled={!claimKey || !kind || !label || !theoryConditions.trim() || !referenceConditions.trim() || !note.trim()} onClick={() => void execute(async () => {
        setPreview(null); const claim = claims.find(c => c.key === claimKey);
        if (!claim) throw new Error('Accepted claim has changed. Please select again.');
        const value = await prepareExternalRelation(run.id, pairId, { claimRunId: claim.run.id, claimId: claim.claim.id, kind: kind as 'supports' | 'contradicts', label: label as CompatibilityAssessment['label'], theoryConditions, referenceConditions, note });
        setPreview({ key, value });
      })}>Preview comparison relation approval</button>
      {visible && <section aria-label="Preview comparison relation approval"><p>Source: {visible.sourceName} · Model suggestion: {visible.assessment.label} · User judgment: {visible.proposal.assessment!.label}</p>
        <pre>{visible.proposal.from.quote}</pre><pre>{visible.proposal.to.quote}</pre><pre>{JSON.stringify(visible.proposal, null, 2)}</pre>
        <button type="button" onClick={() => {
          if (!window.confirm('Have you verified the currently accepted claim, both source quotes, conditions, and relation type? This saves a user-approved relation separately from the model result and does not constitute proof or issue resolution.')) return;
          void execute(async () => { await approveExternalRelation(visible); setPreview(null); setStatus('Approved and saved user relation with external comparison lineage. Internal checks and issue resolution statuses remain unchanged.'); await onChanged(); });
        }}>Approve &amp; save this comparison relation separately</button>
      </section>}
    </fieldset>
    {run.versionId !== snapshot.version.id && <p>Previous version comparison — re-comparison with current source required</p>}
    {busy && <p role="status">Checking comparison relation…</p>}{!busy && status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
