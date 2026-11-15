import { useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { sendChatMessage } from '../services/llm';
import type { UserSettings } from '../types';
import type { TheorySnapshot } from '../services/theory/types';
import type { ReviewRun } from '../services/theory/reviewTypes';
import { checkerCovers, isLocalChecker } from '../services/theory/reviewTypes';
import { applyTheoryPatch, parseModelReview, prepareReviewRequest, reviewSkeleton, runLocalReview, setClaimAcceptance, resolveReviewIssue } from '../services/theory/reviews';
import { activeAttempt, changeCampaignBudget, closeCampaign, confirmCampaignResume, ensureCampaign, finishReviewAttempt, getCampaign, recoverExpiredAttempt, reserveReviewAttempt, spentTime, startNewCampaign, type ReviewCampaign } from '../services/theory/campaigns';
import { campaignStop, STOP_LABELS } from '../services/theory/campaignPolicy';
import { reviewToMarkdown } from '../services/theory/reviewReport';
import { assertGraphReviewCurrent, prepareGraphReview, type GraphReviewPreparation } from '../services/theory/reviewGraph';
import PatchImpact from './PatchImpact';
import ExternalRelationApproval from './ExternalRelationApproval';
import ExternalReview from './ExternalReview';
import ReferenceSource from './ReferenceSource';
import type { ContextEvidence } from '../services/retrieval/types';

const outcomeLabels = { issues: 'Items to review', scope_passed: 'No structural issues in checked scope', insufficient: 'Insufficient evidence' };
const statusLabels: Record<ReviewRun['status'], string> = { complete: 'Check complete', stopped: 'Check aborted', failed: 'Check failed' };
const issueKindLabels: Record<ReviewRun['issues'][number]['kind'], string> = {
  missing_contract: 'Missing research criteria',
  broken_reference: 'Referenced paragraph not found',
  argument: 'Logical step needs review',
  scope: 'Scope needs review',
  counterexample: 'Counterexample candidate',
  insufficient_evidence: 'Insufficient supporting evidence',
  invalid_declaration: 'Symbol/dependency declaration format needs review',
  symbol_conflict: 'Symbol definition conflict',
  undefined_symbol: 'Undefined symbol',
  proof_cycle: 'Proof dependency cycle candidate'
};
const severityLabels: Record<ReviewRun['issues'][number]['severity'], string> = { info: 'Info', warning: 'Warning', critical: 'Critical' };
const claimKindLabels: Record<ReviewRun['claims'][number]['kind'], string> = {
  assumption: 'Assumption', definition: 'Definition', conjecture: 'Conjecture', lemma: 'Lemma', theorem: 'Theorem', result: 'Claim / Result'
};
const blockKindLabels: Record<TheorySnapshot['blocks'][number]['kind'], string> = {
  heading: 'Heading', paragraph: 'Paragraph', code: 'Code', math: 'Math'
};
const contractLabels: Record<keyof TheorySnapshot['version']['contract'], string> = {
  purpose: 'Purpose', assumptions: 'Assumptions & Axioms', definitions: 'Key Definitions', symbols: 'Symbols', scope: 'Scope', openQuestions: 'Open Questions'
};

export default function TheoryReview({ snapshot, settings, modelId, dirty, onSaved }: {
  snapshot: TheorySnapshot; settings: UserSettings; modelId: string; dirty: boolean; onSaved: (snapshot: TheorySnapshot) => void;
}) {
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [selected, setSelected] = useState<string[]>(snapshot.blocks.map(block => block.id));
  const [preview, setPreview] = useState('');
  const [previewVersion, setPreviewVersion] = useState('');
  const [previewModel, setPreviewModel] = useState('');
  const [includeGraph, setIncludeGraph] = useState(false);
  const [graphPreview, setGraphPreview] = useState<GraphReviewPreparation | null>(null);
  const [externalOriginal, setExternalOriginal] = useState<ContextEvidence | null>(null);
  const [modelRunning, setModelRunning] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [campaign, setCampaign] = useState<ReviewCampaign | null>(null);
  const [campaignHistory, setCampaignHistory] = useState<ReviewCampaign[]>([]);
  const [decisionNote, setDecisionNote] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const requestBudget = campaign?.maxRequests ?? 3;
  const usedRequests = campaign?.attempts.length ?? 0;
  const runningAttempt = campaign && activeAttempt(campaign);
  const stop = campaign ? campaignStop(campaign, runs) : null;
  const selectedCurrent = selected.filter(id => snapshot.blocks.some(block => block.id === id));
  const previewBlockIds = graphPreview?.blockIds ?? selectedCurrent;
  const previewBlocks = snapshot.blocks.filter(block => previewBlockIds.includes(block.id));
  const omittedBlocks = snapshot.blocks.filter(block => !previewBlockIds.includes(block.id));
  const previewDocument = previewBlocks.length === snapshot.blocks.length
    ? snapshot.version.markdown : previewBlocks.map(block => block.text).join('\n');
  const filledContract = (Object.keys(contractLabels) as (keyof typeof contractLabels)[])
    .filter(key => snapshot.version.contract[key].trim());
  const controller = useRef<AbortController | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (preview && previewVersion === snapshot.version.id && previewModel === modelId) {
      previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [preview, previewVersion, previewModel, snapshot.version.id, modelId]);
  const refresh = async () => {
    setRuns(await qaxiomDatabase.review_runs.where('documentId').equals(snapshot.document.id).reverse().sortBy('createdAt'));
    setCampaign(await ensureCampaign(snapshot.document.id));
    setCampaignHistory(await qaxiomDatabase.review_campaigns.where('documentId').equals(snapshot.document.id).toArray());
  };
  useEffect(() => {
    let active = true;
    void qaxiomDatabase.review_runs.where('documentId').equals(snapshot.document.id).reverse().sortBy('createdAt')
      .then(runs => { if (active) setRuns(runs); }).catch(() => { if (active) setError('Failed to load review history.'); });
    void ensureCampaign(snapshot.document.id).then(value => { if (active) setCampaign(value); })
      .catch(() => { if (active) setError('Failed to load review budget.'); });
    void qaxiomDatabase.review_campaigns.where('documentId').equals(snapshot.document.id).toArray()
      .then(value => { if (active) setCampaignHistory(value); }).catch(() => { });
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void getCampaign(snapshot.document.id).then(async value => {
        if (active && value) setCampaign(value);
        const updated = await qaxiomDatabase.review_runs.where('documentId').equals(snapshot.document.id).reverse().sortBy('createdAt');
        if (active) setRuns(updated);
      }).catch(() => { });
    }, 2000);
    return () => { active = false; window.clearInterval(timer); controller.current?.abort(); };
  }, [snapshot.document.id]);
  const execute = async (task: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Review operation failed'); }
    finally { setBusy(false); }
  };
  const askModel = () => execute(async () => {
    const prepared = includeGraph ? graphPreview : null;
    const blockIds = prepared?.blockIds ?? selectedCurrent;
    if (!campaign || !preview || previewModel !== modelId || previewVersion !== snapshot.version.id
      || (includeGraph && (!prepared || selectedCurrent.length !== prepared.graph.targetBlockIds.length || selectedCurrent.some(id => !prepared.graph.targetBlockIds.includes(id))))
      || preview !== prepareReviewRequest(snapshot, blockIds, prepared?.graph)) throw new Error('Please re-verify the transmission scope or round budget.');
    const attempt = await reserveReviewAttempt(campaign.id, snapshot, blockIds, modelId, qaxiomDatabase, prepared ?? undefined);
    await refresh();
    const abort = new AbortController(); controller.current = abort;
    setModelRunning(true);
    const started = performance.now(); let text = '', failure: Error | null = null;
    const timeout = window.setTimeout(() => abort.abort(), Math.max(0, attempt.deadlineAt - Date.now()));
    let run: ReviewRun;
    try {
      await sendChatMessage([{ id: crypto.randomUUID(), role: 'user', content: preview, timestamp: Date.now() }], modelId, 'peer_review', settings, {
        onChunk: chunk => { text += chunk; if (text.length > 100000) { failure = new Error('Review response exceeded size limit'); abort.abort(); } },
        onError: error => { failure = error; }, onFinish: () => { }
      }, abort.signal);
      if (failure) throw failure;
      if (abort.signal.aborted) throw new Error('Review was aborted or exceeded the 120s time budget.');
      if (prepared) await assertGraphReviewCurrent(snapshot, prepared);
      run = parseModelReview(text, snapshot, blockIds, modelId);
      if (prepared?.graph.proofCycleRelationIds.length) {
        run.limitations.push('Cycle candidate(s) exist in approved proof dependencies. This is not a ruling on truth or consistency; user verification is required.');
        run.outcome = run.issues.length ? 'issues' : 'insufficient';
      }
      run.durationMs = performance.now() - started;
    } catch (cause) {
      run = reviewSkeleton(snapshot, 'llm-v1', [], modelId);
      run.status = abort.signal.aborted ? 'stopped' : 'failed'; run.outcome = 'insufficient';
      run.durationMs = performance.now() - started; run.error = cause instanceof Error ? cause.message : 'Review failed';
    } finally { window.clearTimeout(timeout); controller.current = null; setModelRunning(false); }
    try { await finishReviewAttempt(campaign.id, attempt.token, run); setPreview(''); }
    finally { await refresh(); }
    if (run.error) throw new Error(run.error);
  });
  const prepareSimpleReview = () => execute(async () => {
    const allBlocks = snapshot.blocks.map(block => block.id);
    const request = prepareReviewRequest(snapshot, allBlocks);
    setSelected(allBlocks); setIncludeGraph(false); setGraphPreview(null);
    setPreviewVersion(snapshot.version.id); setPreviewModel(modelId); setPreview(request);
  });
  const latest = runs[0];
  return <section aria-label="Document Review" className="theory-review">
    <div className="theory-review-intro">
      <div>
        <p className="theory-review-eyebrow">Current document · v{snapshot.version.number}</p>
        <h4>{snapshot.version.title}</h4>
        <p>AI suggests claims and logical points to inspect in the document. Results are advisory only and do not guarantee consistency or truth.</p>
      </div>
      <p className="theory-review-model">Model <strong>{modelId}</strong></p>
    </div>
    {dirty && <p className="theory-review-warning" role="status">You have unsaved edits. Save as a new version before analyzing.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="theory-review-primary">
      <div><strong>Full research note analysis</strong><p>Checks the saved document and research criteria together. Conversations, references, and raw PDFs are not sent.</p></div>
      <button type="button" disabled={busy || dirty || !campaign || !!runningAttempt || !!campaign.closure || !!stop || usedRequests >= requestBudget || !snapshot.blocks.length}
        onClick={() => void prepareSimpleReview()}>Inspect transmission content</button>
    </div>
    <p className="theory-review-progress">Used {usedRequests}/{requestBudget} review requests{usedRequests > 0 && ' · Model costs apply per request'}</p>
    {(stop || campaign?.closure || usedRequests >= requestBudget) && <p className="theory-review-warning">Check stop reasons or request limits under &ldquo;Review Round Management&rdquo; below to continue analyzing.</p>}
    <details className="theory-review-advanced"><summary>Partial analysis &amp; extra context (optional)</summary>
      <p>Use this to re-check specific sections or include approved prerequisite relations. Standard analysis sends the entire saved document at once.</p>
      {runningAttempt && !modelRunning && <p>Deadline from another tab or interrupted run: {new Date(runningAttempt.deadlineAt).toLocaleTimeString()}. No automatic re-transmission will occur.</p>}
      {runningAttempt && !modelRunning && <button type="button" disabled={busy || now <= runningAttempt.deadlineAt} onClick={() => void execute(async () => {
        const version = await qaxiomDatabase.document_versions.get(runningAttempt.versionId);
        if (!version || !campaign) throw new Error('Review source version not found.');
        const blocks = await qaxiomDatabase.document_blocks.where('versionId').equals(version.id).sortBy('position');
        await recoverExpiredAttempt(campaign.id, { document: snapshot.document, version, blocks, history: snapshot.history }); await refresh();
      })}>Close expired run · Prepare resume</button>}
      <fieldset disabled={busy || dirty || !campaign || !!runningAttempt || !!campaign.closure}>
        <legend>Paragraphs &amp; extra context to send</legend>
        <p>Sends only the selected paragraphs and full research criteria. Unselected paragraphs remain unchecked.</p>
        <label><input type="checkbox" checked={includeGraph} onChange={event => { setIncludeGraph(event.target.checked); setPreview(''); setGraphPreview(null); }} />Include premises &amp; definitions from approved relations</label>
        {includeGraph && <p>Adds approved premises linked to selected paragraphs. Extra context is shown in the transmission scope; external references are excluded.</p>}
        <label>Max review requests<input aria-label="Max review requests" type="number" min={1} max={100} value={requestBudget} onChange={event => {
          const value = Number(event.target.value); setPreview('');
          if (campaign) void execute(async () => { setCampaign(await changeCampaignBudget(campaign.id, value)); });
        }} /></label>
        <p>Used {usedRequests}/{requestBudget} · Max 120s per request · Recorded time {Math.ceil((campaign ? spentTime(campaign) : 0) / 1000)}/{requestBudget * 120}s. Failed runs also count toward the budget. Token cost estimates are not provided.</p>
        <div className="theory-review-block-list">{snapshot.blocks.map(block => <label className="reference-choice" key={block.id}>
          <input type="checkbox" checked={selected.includes(block.id)} onChange={event => {
            setPreview(''); setGraphPreview(null); setSelected(previous => event.target.checked ? [...previous, block.id] : previous.filter(id => id !== block.id));
          }} /><span>Paragraph {block.position + 1} · {blockKindLabels[block.kind]} · {block.text.slice(0, 100)}</span>
        </label>)}</div>
        <button type="button" disabled={!selectedCurrent.length || usedRequests >= requestBudget || !!stop} onClick={() => void execute(async () => {
          setPreview(''); setGraphPreview(null);
          const prepared = includeGraph ? await prepareGraphReview(snapshot, selectedCurrent) : null;
          setGraphPreview(prepared); setPreviewVersion(snapshot.version.id); setPreviewModel(modelId);
          setPreview(prepared?.request ?? prepareReviewRequest(snapshot, selectedCurrent));
        })}>Preview review transmission</button>
      </fieldset>
    </details>
    {(usedRequests > 0 || !!stop || !!campaign?.closure || campaignHistory.some(item => item.id !== campaign?.id)) && <details className="theory-review-advanced"><summary>Review Round Management</summary>
      {stop && !campaign?.closure && <section aria-label="Review stop reason">
        <h4>Confirmation required before next request</h4>
        {stop.reasons.map(reason => <p key={reason}>{STOP_LABELS[reason]}</p>)}
        <p>Repetition/recurrence indicates candidate matches by kind, block ID, and normalized quote. It does not establish semantic identity or actual recurrence, nor does confirmation mark an issue resolved.</p>
        <label>Reason to resume or close<textarea value={decisionNote} maxLength={2000} onChange={event => setDecisionNote(event.target.value)} /></label>
        <button type="button" disabled={busy || !!runningAttempt || !decisionNote.trim()} onClick={() => void execute(async () => {
          if (campaign) await confirmCampaignResume(campaign.id, stop.runId, decisionNote);
          setDecisionNote(''); setPreview(''); await refresh();
        })}>Confirm stop reason · Allow manual resume</button>
      </section>}
      {campaign?.closure ? <section aria-label="Closed review">
        <p>This review is closed · Version {campaign.closure.versionId} · {campaign.closure.note}. Closing is a user decision and does not indicate consistency pass.</p>
        <button type="button" disabled={busy || dirty} onClick={() => {
          if (!window.confirm('Preserve previous usage history and start a new review budget (3 requests)? No automatic requests will be sent.')) return;
          void execute(async () => { await startNewCampaign(campaign.id); setPreview(''); setDecisionNote(''); await refresh(); });
        }}>Start new review · Preserve history</button>
      </section> : campaign && <section aria-label="Close review">
        {!stop && <label>Reason to resume or close<textarea value={decisionNote} maxLength={2000} onChange={event => setDecisionNote(event.target.value)} /></label>}
        <p>Check checked scope, unchecked items, and unresolved issues before recording a closure reason. You can close with unresolved issues; this does not convert to a pass verdict.</p>
        <button type="button" disabled={busy || dirty || !!runningAttempt || !decisionNote.trim()} onClick={() => void execute(async () => {
          await closeCampaign(campaign.id, snapshot, decisionNote); setDecisionNote(''); setPreview(''); await refresh();
        })}>Close this review · Keep verdict</button>
      </section>}
      {!!campaignHistory.filter(item => item.id !== campaign?.id).length && <details><summary>Previous review rounds</summary>
        {campaignHistory.filter(item => item.id !== campaign?.id).map(item => <p key={item.id}>Review {item.id} · Used {item.attempts.length}/{item.maxRequests} · {item.closure?.note ?? 'Past record'}</p>)}
      </details>}
      {!!campaign?.confirmations?.length && <details><summary>Stop-reason confirmations</summary>
        {campaign.confirmations.map((item, index) => <div key={index}>
          <p>Review {item.runId} · {new Date(item.createdAt).toLocaleString()} · {item.reasons.map(reason => STOP_LABELS[reason]).join(', ')}</p>
          <p>{item.note} · Does not mark issues resolved or consistency passed</p>
        </div>)}
      </details>}
    </details>}
    <details className="theory-review-advanced theory-review-local"><summary>Local structure check · No network transmission</summary>
      <p>Checks only empty research criteria, paragraph links, and symbol declaration formats. Does not evaluate prose meaning or theoretical validity.</p>
      <button type="button" disabled={busy || dirty} onClick={() => void execute(async () => { await runLocalReview(snapshot); await refresh(); })}>Run basic structure check</button>
    </details>
    {preview && previewVersion === snapshot.version.id && previewModel === modelId && <section ref={previewRef} className="theory-review-preview" aria-label="Review transmission preview">
      <p className="theory-review-eyebrow">Pre-send check · Not yet sent to model</p>
      <h4>Content to send to AI</h4>
      {includeGraph && graphPreview && <p>Targets: {graphPreview.graph.targetBlockIds.length} blocks · Additional premises: {graphPreview.graph.premiseBlockIds.length} blocks · Approved relations: {graphPreview.graph.relationSnapshots.length} · Excluded external sources: {graphPreview.graph.excludedCounts.external_not_selected}. Attaching extra context does not mean it is checked.</p>}
      <p>Selected model: {modelId} · {omittedBlocks.length ? `Selected paragraphs ${previewBlocks.length}/${snapshot.blocks.length}` : 'Full document'} · Filled criteria {filledContract.length}/6 · Approx. request size {Math.ceil(new TextEncoder().encode(preview).byteLength / 1024)} KB</p>
      {!!filledContract.length && <details open><summary>Research criteria included ({filledContract.length})</summary>
        {filledContract.map(key => <div key={key}><strong>{contractLabels[key]}</strong><p>{snapshot.version.contract[key]}</p></div>)}
      </details>}
      <div className="theory-review-preview-blocks">
        <strong>Document source text included</strong>
        <pre className="theory-review-document">{previewDocument}</pre>
      </div>
      {!!omittedBlocks.length && <details><summary>Excluded paragraphs ({omittedBlocks.length})</summary>
        <p>Paragraph(s) {omittedBlocks.map(block => block.position + 1).join(', ')} are excluded from this request and will not be included in the check results.</p>
      </details>}
      <p>Excluded from this request: existing conversations, references, and raw PDFs. The app does not auto-split or truncate the request body. Actual provider model limits may differ.</p>
      <details className="theory-review-technical"><summary>Technical details of transmission request</summary>
        <p>Instructions inside the document are passed as data to be reviewed. The content below includes version, hash, omitted IDs, and model output format.</p><pre>{preview}</pre>
      </details>
      <p>Running this sends a request to the selected model and may incur API costs.</p>
      <button type="button" className="theory-review-send" disabled={busy || dirty || usedRequests >= requestBudget || !!stop || !!campaign?.closure || !!runningAttempt} onClick={() => void askModel()}>Run LLM review with this scope</button>
    </section>}
    {busy && <p role="status">Review operation in progress…</p>}
    {modelRunning && busy && <button type="button" onClick={() => controller.current?.abort()}>Abort review</button>}
    <details className="theory-external-advanced"><summary>Compare with external literature (optional)</summary>
      <ExternalReview snapshot={snapshot} settings={settings} modelId={modelId} campaign={campaign} disabled={busy || dirty || !!stop || !!campaign?.closure || usedRequests >= requestBudget} onChanged={refresh} />
    </details>
    <div className="theory-review-results-heading"><h4>Review Results</h4><p>Displays saved analyses and local checks in reverse chronological order. Suggestions serve as starting points for editing and re-checking.</p></div>
    {!runs.length && <p className="theory-review-empty">No check results yet.</p>}
    {latest && latest.versionId !== snapshot.version.id && <p>The previous review is for an older version. Please re-check the current version.</p>}
    {runs.map(run => {
      const version = snapshot.history.find(item => item.id === run.versionId);
      const current = run.versionId === snapshot.version.id;
      const missingCriteria = run.issues.filter(issue => issue.kind === 'missing_contract');
      const otherIssues = run.issues.filter(issue => issue.kind !== 'missing_contract');
      const emptyCriteria = current
        ? (Object.keys(contractLabels) as (keyof typeof contractLabels)[]).filter(key => !snapshot.version.contract[key].trim()).map(key => contractLabels[key])
        : [];
      const reviewName = isLocalChecker(run.checker) ? 'Basic structure check'
        : run.checker === 'external-v1' ? `AI external source comparison · ${run.modelId}` : `AI content & logic review · ${run.modelId}`;
      return <article key={run.id} aria-label={`Review result ${run.id}`} className="theory-review-result">
        <h4>{reviewName}</h4>
        <p className="theory-review-summary"><strong>{statusLabels[run.status]}</strong> · {outcomeLabels[run.outcome]} · {version ? `v${version.number}` : 'Saved past version'}</p>
        <button type="button" disabled={busy} onClick={() => void execute(async () => {
          const version = await qaxiomDatabase.document_versions.get(run.versionId);
          if (!version) throw new Error('Review source version not found.');
          const blocks = await qaxiomDatabase.document_blocks.where('versionId').equals(version.id).sortBy('position');
          const url = URL.createObjectURL(new Blob([reviewToMarkdown(run, version, blocks)], { type: 'text/markdown;charset=utf-8' }));
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = `qaxiom-review-${run.id}.md`; anchor.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        })}>Export review report</button>
        <p>Checked {run.checkedBlockIds.length}/{run.checkedBlockIds.length + run.uncheckedBlockIds.length} paragraph(s) · Unchecked {run.uncheckedBlockIds.length} {!current && '· Previous version result'}</p>
        {run.external && <section aria-label="External comparison results"><p>External pairs checked: {run.external.checkedPairIds.length}/{run.external.context.pairs.length}. Not counted toward internal argument checks. Classifications are model suggestions, not relation approvals or proofs.</p>
          {run.external.assessments.map(a => {
            const pair = run.external!.context.pairs.find(p => p.id === a.pairId), evidence = run.external!.context.evidence.find(e => e.citationId === pair?.citationId);
            return <div key={a.pairId}><p>{a.label} · {a.explanation}</p><p>Theory conditions: {a.theoryConditions} / Source conditions: {a.referenceConditions}</p><pre>{a.theoryQuote}</pre><pre>{a.referenceQuote}</pre>
              {evidence && <button type="button" onClick={() => setExternalOriginal(evidence)}>Inspect compared source: {evidence.name}</button>}
              <ExternalRelationApproval run={run} pairId={a.pairId} snapshot={snapshot} runs={runs} disabled={busy || dirty || !!runningAttempt} onChanged={refresh} /></div>;
          })}
          <p>Source quotes, conditions, and omitted ranges at the time of transmission are preserved in the exported review report.</p></section>}
        {run.graph && <p>Sent {run.graph.targetBlockIds.length} target paragraph(s) and {run.graph.premiseBlockIds.length} additional premise paragraph(s) with approved relations. Additional premises are not included in the checked count.</p>}
        {run.error && <p>{run.error}</p>}
        {!!run.limitations.length && <details className="theory-review-limitations"><summary>What this check did not verify</summary>
          {run.limitations.map((limitation, index) => <p key={index}>{limitation}</p>)}</details>}
        {!!missingCriteria.length && <section className="theory-review-notice" aria-label="Unfilled research criteria">
          <strong>{missingCriteria.length} research criteria item(s) are empty.</strong>
          <p>Missing items: {emptyCriteria.length ? emptyCriteria.join(', ') : 'Some research criteria at the time of review'}. These fields are optional; fill them in when you want to clarify the scope for AI review.</p>
        </section>}
        <details open={run.checker === 'llm-v1'}><summary>{run.claims.length} claim candidate(s) found in document</summary>
          <p>Automatically classified candidates based on headings and phrasing. This does not mean the content was understood or judged true.</p>
          {run.claims.map(claim => {
            const block = current ? snapshot.blocks.find(item => item.id === claim.blockId) : null;
            return <div key={claim.id}><p>{claimKindLabels[claim.kind]} · {claim.origin === 'model' ? 'Suggested by AI' : 'Inferred from document structure'}{block ? ` · Paragraph ${block.position + 1}` : ''}</p><pre>{claim.statement}</pre>
              <select aria-label={`Claim acceptance status ${claim.id}`} value={claim.acceptance} disabled={busy} onChange={event => void execute(async () => {
                await setClaimAcceptance(run.id, claim.id, event.target.value as typeof claim.acceptance); await refresh();
              })}><option value="proposed">Proposed</option><option value="accepted">Accepted</option><option value="rejected">Rejected</option></select>
            </div>;
          })}
        </details>
        {otherIssues.map(issue => <div className="theory-change theory-review-issue" key={issue.id}><strong>{severityLabels[issue.severity]} · {issueKindLabels[issue.kind]}</strong>
          <p>{issue.resolvedByRunId ? `Marked resolved by user after re-check · ${issue.resolvedByRunId}` : 'Unresolved'}</p>
          <p>{issue.explanation}</p><p>Resolution condition: {issue.resolution}</p>
          {!issue.resolvedByRunId && run.versionId !== snapshot.version.id && runs.some(recheck => recheck.versionId === snapshot.version.id && checkerCovers(run.checker, recheck.checker) && recheck.outcome === 'scope_passed' && !recheck.uncheckedBlockIds.length) &&
            <button type="button" disabled={busy || dirty} onClick={() => {
              if (!window.confirm('Have you verified the full-scope re-check results and resolution conditions on the subsequent version? This reflects user judgment and does not guarantee theoretical truth.')) return;
              const recheck = runs.find(recheck => recheck.versionId === snapshot.version.id && checkerCovers(run.checker, recheck.checker) && recheck.outcome === 'scope_passed' && !recheck.uncheckedBlockIds.length)!;
              void execute(async () => { await resolveReviewIssue(run.id, issue.id, recheck.id); await refresh(); });
            }}>Verify re-check · Mark issue resolved</button>}
          {issue.quotes.map((quote, index) => {
            const block = current ? snapshot.blocks.find(item => item.id === issue.blockIds[index]) : null;
            return <pre key={index}>{block ? `Paragraph ${block.position + 1}: ` : ''}{quote}</pre>;
          })}
          {run.patches.filter(patch => patch.issueIds.includes(issue.id)).map(patch => <div key={patch.id}>
            <p>New assumptions: {patch.introducedAssumptions || 'None declared (verify no hidden assumptions were introduced)'}</p>
            <details><summary>Technical details of patch suggestion</summary><p>Original source hash before edit: {patch.beforeHash}</p></details>
            <div className="theory-diff"><pre>{snapshot.version.id === run.versionId ? snapshot.blocks.find(block => block.id === patch.blockId)?.text : 'Source text from previous version'}</pre><pre>{patch.replacement}</pre></div>
            <PatchImpact run={run} patch={patch} snapshot={snapshot} runs={runs} disabled={busy || dirty} onApply={impact => {
              void execute(async () => { const saved = await applyTheoryPatch(run.id, patch.id, qaxiomDatabase, impact); setPreview(''); setGraphPreview(null); setSelected(saved.blocks.map(block => block.id)); onSaved(saved); await refresh(); });
            }} onSelect={blockIds => { setSelected(blockIds); setPreview(''); setGraphPreview(null); setIncludeGraph(false); }} />
          </div>)}
        </div>)}
      </article>;
    })}
    {externalOriginal && <ReferenceSource evidence={externalOriginal} onClose={() => setExternalOriginal(null)} />}
  </section>;
}
