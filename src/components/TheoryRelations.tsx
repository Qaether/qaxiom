import { lazy, Suspense, useEffect, useState } from 'react';
import type { TheorySnapshot } from '../services/theory/types';
import { approveRelation, claimAnchor, loadRelationWiki, retractRelation, type RelationProposal } from '../services/theory/relations';
import { COMPATIBILITY_LABELS, RELATION_KINDS, anchorKey, type ResearchRelation } from '../services/theory/relationTypes';
import { relationGraph } from '../services/theory/relationGraph';
import { createContextBundle } from '../services/retrieval/context';
import { spanLocation } from '../services/retrieval/pdfTypes';
import type { ContextEvidence } from '../services/retrieval/types';
import { relationWikiToMarkdown } from '../services/theory/relationReport';
import { qaxiomDatabase } from '../services/database';
import { hashText } from '../services/theory/blocks';

const ReferenceSource = lazy(() => import('./ReferenceSource'));
const kindLabels = { depends_on: 'Depends on', defines: 'Defines', supports: 'Support candidate', contradicts: 'Conflict candidate' };
const statusLabels = { active: 'Active approved relation', stale: 'Stale version — re-verification needed', retracted: 'User retracted', claim_unaccepted: 'Claim unaccepted/retracted — excluded' };

export default function TheoryRelations({ snapshot, dirty }: { snapshot: TheorySnapshot; dirty: boolean }) {
  const [wiki, setWiki] = useState<Awaited<ReturnType<typeof loadRelationWiki>> | null>(null);
  const [fromKey, setFrom] = useState(''), [targetKey, setTarget] = useState(''), [focusKey, setFocus] = useState('');
  const [targetType, setTargetType] = useState<'claim' | 'reference'>('claim');
  const [sourceId, setSource] = useState('');
  const [kind, setKind] = useState<ResearchRelation['kind']>('depends_on');
  const [dependencyType, setDependencyType] = useState<'proof' | 'concept'>('concept');
  const [label, setLabel] = useState<typeof COMPATIBILITY_LABELS[number]>('insufficient_evidence');
  const [theoryConditions, setTheoryConditions] = useState(''), [referenceConditions, setReferenceConditions] = useState('');
  const [note, setNote] = useState(''), [retractionNote, setRetractionNote] = useState('');
  const [preview, setPreview] = useState<{ key: string; proposal: RelationProposal } | null>(null);
  const [evidence, setEvidence] = useState<ContextEvidence | null>(null);
  const [rawBlock, setRawBlock] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () => void loadRelationWiki(snapshot.document.id).then(value => { if (active) setWiki(value); }).catch(() => { if (active) setError('Failed to load claim relations.'); });
    refresh(); const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [snapshot.document.id, snapshot.version.id]);
  const current = wiki?.snapshot.version.id === snapshot.version.id;
  const claims = wiki?.runs.flatMap(run => run.claims.map(claim => ({ run, claim, key: JSON.stringify(['claim', run.id, claim.id]) }))) ?? [];
  const accepted = claims.filter(n => n.run.versionId === snapshot.version.id && n.claim.acceptance === 'accepted');
  const focus = claims.find(n => n.key === focusKey);
  const activeRelations = wiki?.entries.filter(e => e.status === 'active').map(e => e.relation) ?? [];
  const graph = relationGraph(activeRelations, focusKey);
  const key = JSON.stringify([snapshot.version.id, fromKey, targetKey, targetType, sourceId, kind, dependencyType, label, theoryConditions, referenceConditions, note]);
  const visiblePreview = preview?.key === key && !dirty && current ? preview.proposal : null;
  const execute = async (task: () => Promise<void>) => {
    setBusy(true); setError(''); setStatus('');
    try { await task(); setWiki(await loadRelationWiki(snapshot.document.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Relation operation failed'); }
    finally { setBusy(false); }
  };
  const openReference = (relation: ResearchRelation) => {
    if (!wiki || relation.to.type !== 'reference') return;
    const target = relation.to;
    const source = wiki.references.find(s => s.id === target.sourceId), span = wiki.spans.find(s => s.id === target.spanId);
    if (!source || !span) { setError('Anchored source span not found.'); return; }
    const own = wiki.snapshot.history.find(v => v.contentHash === source.contentHash);
    const item = createContextBundle('Inspect relation source text', [source.id], [{ source: own ? { ...source, role: 'theory_snapshot', originVersionId: own.id } : source, span, score: 0 }]);
    setEvidence(item.evidence[0]);
  };
  const claimName = (node: typeof claims[number]) => `${node.run.versionId === snapshot.version.id ? 'Current' : 'Past'} · ${node.claim.kind} · ${node.claim.statement.slice(0, 70)} · ${node.claim.id.slice(0, 8)}`;
  return <section aria-label="Claim relations and Wiki" className="theory-review">
    <h3>Claim Relations · Wiki · External Comparison</h3>
    <p>Links accepted claims anchored to source text with directly selected evidence. Relation approvals and compatibility labels reflect user judgment and do not guarantee truth, proof, or internal consistency. No automatic API calls are made.</p>
    {dirty && <p>You have unsaved changes. Save first, then review/accept claims for the current version and re-approve relations.</p>}
    {!current && wiki && <p>The canonical version was changed in another tab. Please reopen the document.</p>}
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    <fieldset disabled={busy || dirty || !current}>
      <legend>Create relation — currently accepted claims only</legend>
      {!accepted.length && <p>Accept claim candidates in Document Review, then click &ldquo;Refresh relation list&rdquo;.</p>}
      <button type="button" onClick={() => void execute(async () => {})}>Refresh relation list</button>
      <label>Source claim<select aria-label="Source claim" value={fromKey} onChange={event => setFrom(event.target.value)}><option value="">Select</option>{accepted.map(n => <option key={n.key} value={n.key}>{claimName(n)}</option>)}</select></label>
      <label>Target type<select value={targetType} onChange={event => { const type = event.target.value as typeof targetType; setTargetType(type); setTarget(''); setKind(type === 'claim' ? 'depends_on' : 'supports'); }}><option value="claim">Accepted claim</option><option value="reference">Selected source span</option></select></label>
      {targetType === 'reference' && <label>Reference to link<select value={sourceId} onChange={event => { setSource(event.target.value); setTarget(''); }}><option value="">Select a source</option>{wiki?.references.map(s => <option key={s.id} value={s.id}>{s.name} · {s.role}</option>)}</select></label>}
      <label>Target claim or span<select value={targetKey} onChange={event => setTarget(event.target.value)}><option value="">Select</option>{targetType === 'claim'
        ? accepted.filter(n => n.key !== fromKey).map(n => <option key={n.key} value={n.key}>{claimName(n)}</option>)
        : wiki?.spans.filter(s => s.sourceId === sourceId).map(s => <option key={s.id} value={s.id}>{spanLocation(s)} · {s.text.slice(0, 70)}</option>)}</select></label>
      <label>Relation type<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}>{RELATION_KINDS.filter(k => targetType === 'claim' || ['supports', 'contradicts'].includes(k)).map(k => <option key={k} value={k}>{kindLabels[k]}</option>)}</select></label>
      {kind === 'depends_on' && <label>Dependency type<select value={dependencyType} onChange={event => setDependencyType(event.target.value as typeof dependencyType)}><option value="concept">Conceptual link — cycles allowed</option><option value="proof">Proof dependency — check cycle candidates</option></select></label>}
      {targetType === 'reference' && <>
        <label>External comparison classification<select value={label} onChange={event => setLabel(event.target.value as typeof label)}>{COMPATIBILITY_LABELS.map(l => <option key={l} value={l}>{l}</option>)}</select></label>
        <label>Own claim assumptions, definitions, and scope<textarea value={theoryConditions} maxLength={2000} onChange={event => setTheoryConditions(event.target.value)} /></label>
        <label>Source result assumptions, definitions, and scope<textarea value={referenceConditions} maxLength={2000} onChange={event => setReferenceConditions(event.target.value)} /></label>
        <p>Notes, self-authored documents, and canonical documents with the same hash are not counted as independent external evidence. conflict_candidate is not an internal contradiction ruling.</p>
      </>}
      <label>Reason for approving relation<textarea value={note} maxLength={2000} onChange={event => setNote(event.target.value)} /></label>
      <button type="button" disabled={!fromKey || !targetKey || !note.trim()} onClick={() => void execute(async () => {
        const from = accepted.find(n => n.key === fromKey); if (!from || !wiki) throw new Error('Please re-select a currently accepted claim.');
        const target = accepted.find(n => n.key === targetKey);
        const source = wiki.references.find(s => s.id === sourceId), span = wiki.spans.find(s => s.id === targetKey && s.sourceId === sourceId);
        const to = targetType === 'claim' && target ? claimAnchor(target.run, target.claim.id)
          : targetType === 'reference' && source && span ? { type: 'reference' as const, sourceId: source.id, sourceHash: source.contentHash, spanId: span.id, spanHash: span.contentHash, quote: span.text } : null;
        if (!to) throw new Error('Please check the target claim or selected source text.');
        if (to.type === 'reference' && (!theoryConditions.trim() || !referenceConditions.trim())) throw new Error('Please record assumptions, definitions, and scope for both sides.');
        setPreview({ key, proposal: { documentId: snapshot.document.id, from: claimAnchor(from.run, from.claim.id), to, kind,
          dependencyType: kind === 'depends_on' ? dependencyType : null, note: note.trim(),
          assessment: to.type === 'reference' ? { label, theoryConditions: theoryConditions.trim(), referenceConditions: referenceConditions.trim() } : null } });
      })}>Preview relation approval</button>
    </fieldset>
    {visiblePreview && <section aria-label="Preview relation approval">
      <p>{kindLabels[visiblePreview.kind]} · Canonical {visiblePreview.from.versionId} · Verify source and target quotes.</p>
      <pre>{visiblePreview.from.quote}</pre><pre>{visiblePreview.to.quote}</pre>
      <p>Reason: {visiblePreview.note}</p>
      {visiblePreview.assessment && <p>User comparison: {visiblePreview.assessment.label} · Own conditions: {visiblePreview.assessment.theoryConditions} · Source conditions: {visiblePreview.assessment.referenceConditions}</p>}
      <button type="button" disabled={busy} onClick={() => void execute(async () => { await approveRelation(visiblePreview); setPreview(null); setStatus('Approved and saved source-anchored relation. This is not a proof or consistency ruling.'); })}>Approve &amp; save this relation</button>
    </section>}
    <section aria-label="Research Wiki">
      <h4>Research Wiki — derived view of source text and approved relations</h4>
      <button type="button" disabled={busy || !wiki} onClick={() => void execute(async () => {
        const currentWiki = await loadRelationWiki(snapshot.document.id);
        const url = URL.createObjectURL(new Blob([relationWikiToMarkdown(currentWiki)], { type: 'text/markdown;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = `qaxiom-wiki-v${currentWiki.snapshot.version.number}.md`; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      })}>Export Research Wiki</button>
      <label>Wiki claim<select aria-label="Wiki claim" value={focusKey} onChange={event => setFocus(event.target.value)}><option value="">Select a claim to explore</option>{claims.map(n => <option key={n.key} value={n.key}>{claimName(n)} · {n.claim.acceptance}</option>)}</select></label>
      {focus && <>
        <p>Review {focus.run.id} · Version {focus.run.versionId} · Block {focus.claim.blockId} · {focus.claim.acceptance}</p>
        <pre>{focus.claim.statement}</pre>
        <button type="button" disabled={busy} onClick={() => void execute(async () => {
          const block = await qaxiomDatabase.document_blocks.get([focus.run.versionId, focus.claim.blockId]);
          if (!block || block.contentHash !== focus.claim.blockHash || await hashText(block.text) !== focus.claim.blockHash) throw new Error('The claim source text for this version is missing or modified.');
          setRawBlock({ key: focus.key, text: block.text });
        })}>Inspect claim source block</button>
        {rawBlock?.key === focusKey && <pre aria-label="Full Wiki claim block">{rawBlock.text}</pre>}
        <p>Current approved links: Outgoing {graph.outgoing.length} · Backlinks {graph.incoming.length} · Prerequisite dependencies {graph.dependencies.length} · Impacted claims {graph.impacted.length}. Undeclared relations are excluded.</p>
        <details><summary>Prerequisite dependencies and impacted claims</summary>{[...graph.dependencies.map(id => ({ id, label: 'Premise' })), ...graph.impacted.map(id => ({ id, label: 'Impacted' }))].map(n => <p key={n.label + n.id}>{n.label}: {claims.find(c => c.key === n.id)?.claim.statement ?? n.id}</p>)}</details>
      </>}
      {!!graph.proofCycleRelationIds.length && <p role="alert">{graph.proofCycleRelationIds.length} cycle candidate(s) detected in approved proof dependencies. Conceptual link cycles are not treated as errors. This is not an automated proof ruling.</p>}
      <p>Independent external comparisons: {wiki?.entries.filter(e => e.status === 'active' && e.independent).length ?? 0} · External disagreements are distinguished from internal contradictions.</p>
    </section>
    <section aria-label="Approved relation history">
      <h4>Approved Relations · Backlinks · History</h4>
      <label>Reason for retracting relation<textarea value={retractionNote} maxLength={2000} onChange={event => setRetractionNote(event.target.value)} /></label>
      {wiki?.entries.filter(e => !focusKey || anchorKey(e.relation.from) === focusKey || anchorKey(e.relation.to) === focusKey).map(({ relation, status: relationStatus, independent, source }) => <article key={relation.id}>
        <p>{kindLabels[relation.kind]} · {statusLabels[relationStatus]} · {relation.id}</p>
        <pre>{relation.from.quote} → {relation.to.quote}</pre><p>{relation.note}</p>
        {relation.externalReviewOrigin && <p>External comparison lineage: {relation.externalReviewOrigin.runId} · Pair {relation.externalReviewOrigin.pairId} · Separately approved by user (not auto-accepted from model)</p>}
        {relation.assessment && <><p>User comparison: {relation.assessment.label} · {independent ? 'Independent external source' : 'Note/self-authored document — not independent external evidence'}</p><p>Own conditions: {relation.assessment.theoryConditions} · Source conditions: {relation.assessment.referenceConditions}</p></>}
        {source && <button type="button" onClick={() => openReference(relation)}>Relation evidence source: {source.name}</button>}
        {relation.retractedAt !== null ? <p>Retraction reason: {relation.retractionNote}</p> : <button type="button" disabled={busy || !retractionNote.trim()} onClick={() => void execute(async () => { await retractRelation(relation.id, retractionNote); setStatus('Relation retracted. Existing approval and source history are preserved.'); })}>Retract this relation</button>}
      </article>)}
      {!wiki?.entries.length && <p>No approved relations.</p>}
    </section>
    {evidence && <Suspense fallback={<p>Loading source view…</p>}><ReferenceSource evidence={evidence} onClose={() => setEvidence(null)} /></Suspense>}
  </section>;
}
