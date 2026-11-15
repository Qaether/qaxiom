import { useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { AVAILABLE_MODELS } from '../constants';
import type { UserSettings } from '../types';
import type { TheorySnapshot } from '../services/theory/types';
import type { ReferenceDocument, ReferenceSpan } from '../services/retrieval/types';
import { spanLocation } from '../services/retrieval/pdfTypes';
import { assertExternalCurrent, prepareExternalReview, parseExternalResponse, type ExternalPairInput, type ExternalPreparation } from '../services/theory/externalReview';
import { activeAttempt } from '../services/theory/campaigns';
import { reserveReviewAttempt, finishReviewAttempt, type ReviewCampaign } from '../services/theory/campaigns';
import { reviewSkeleton } from '../services/theory/reviews';
import { sendChatMessage } from '../services/llm';

export default function ExternalReview({ snapshot, settings, modelId, disabled, campaign, onChanged }: {
  snapshot: TheorySnapshot; settings: UserSettings; modelId: string; disabled: boolean; campaign: ReviewCampaign | null; onChanged: () => Promise<void>;
}) {
  const [sources, setSources] = useState<ReferenceDocument[]>([]), [spans, setSpans] = useState<ReferenceSpan[]>([]);
  const [sourceId, setSourceId] = useState(''), [spanId, setSpanId] = useState(''), [blockId, setBlockId] = useState('');
  const [theoryConditions, setTheoryConditions] = useState(''), [referenceConditions, setReferenceConditions] = useState('');
  const [pairs, setPairs] = useState<ExternalPairInput[]>([]);
  const [preview, setPreview] = useState<{ prepared: ExternalPreparation; modelId: string } | null>(null);
  const [busy, setBusy] = useState(false), [running, setRunning] = useState(false), [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const policyKey = useRef('');
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const all = await qaxiomDatabase.references.toArray(), versions = await qaxiomDatabase.document_versions.toArray();
      const project = await qaxiomDatabase.projects.get(snapshot.document.projectId);
      if (active) {
        const key = JSON.stringify([project?.id, project?.sourcePolicy]);
        if (policyKey.current !== key) { policyKey.current = key; setPreview(null); }
        setSources(all.filter(s => (!project?.sourcePolicy || project.sourcePolicy.allowedSourceIds.includes(s.id)) && s.role === 'external' && s.originVersionId === null && !versions.some(v => v.contentHash === s.contentHash)));
      }
    };
    const update = () => void refresh().catch(() => { if (active) setError('Failed to load external sources list.'); });
    update(); const timer = window.setInterval(update, 2000);
    return () => { active = false; clearInterval(timer); controller.current?.abort(); };
  }, [snapshot.version.id, snapshot.document.projectId]);
  useEffect(() => {
    let active = true;
    void qaxiomDatabase.reference_spans.where('sourceId').equals(sourceId).sortBy('position').then(value => { if (active) setSpans(value); }).catch(() => { if (active) setError('Failed to load source spans.'); });
    return () => { active = false; };
  }, [sourceId]);
  const execute = async (task: () => Promise<void>) => { setBusy(true); setError(''); try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'External comparison failed'); } finally { setBusy(false); } };
  const validPreview = preview?.modelId === modelId && preview.prepared.context.versionId === snapshot.version.id ? preview : null;
  const ask = () => execute(async () => {
    if (!validPreview || !campaign) throw new Error('Please review the external comparison preview again.');
    const model = AVAILABLE_MODELS.find(m => m.id === modelId);
    if (!model || model.provider === 'custom' || !settings.apiKeys[model.provider].trim()) throw new Error('Configure an API key for the selected model. Automatic fallback to another provider is disabled.');
    const prepared = validPreview.prepared;
    const attempt = await reserveReviewAttempt(campaign.id, snapshot, prepared.context.blocks.map(b => b.id), modelId, qaxiomDatabase, undefined, prepared);
    await onChanged();
    const abort = new AbortController(); controller.current = abort; setRunning(true);
    const timeout = window.setTimeout(() => abort.abort(), Math.max(0, attempt.deadlineAt - Date.now()));
    const started = performance.now(); let response = '', failure: Error | null = null;
    const run = reviewSkeleton(snapshot, 'external-v1', [], modelId);
    run.external = { context: prepared.context, checkedPairIds: [], assessments: [] };
    run.limitations = ['Comparison candidates between independent source text and selected conditions. This does not prove internal argument validity, truth, full consistency, or independence.'];
    try {
      await assertExternalCurrent(snapshot, prepared);
      await sendChatMessage([{ id: crypto.randomUUID(), role: 'user', content: prepared.request, timestamp: Date.now() }], modelId, 'peer_review', settings, {
        onChunk: chunk => { response += chunk; if (response.length > 100000) { failure = new Error('External comparison response exceeded size limit'); abort.abort(); } }, onError: cause => { failure = cause; }, onFinish: () => {}
      }, abort.signal);
      if (failure) throw failure;
      if (abort.signal.aborted) throw new Error('External comparison was aborted or exceeded the time budget.');
      await assertExternalCurrent(snapshot, prepared);
      const result = parseExternalResponse(response, prepared.context);
      run.external.checkedPairIds = result.checkedPairIds; run.external.assessments = result.assessments; run.limitations.push(...result.limitations);
    } catch (cause) { run.status = abort.signal.aborted ? 'stopped' : 'failed'; run.error = cause instanceof Error ? cause.message : 'External comparison failed'; }
    finally { window.clearTimeout(timeout); controller.current = null; setRunning(false); run.durationMs = performance.now() - started; }
    try { await finishReviewAttempt(campaign.id, attempt.token, run); setPreview(null); }
    finally { await onChanged(); }
    if (run.error) throw new Error(run.error);
  });
  return <section aria-label="Independent external source comparison">
    <h4>Independent external source comparison — separate from internal argument check</h4>
    <p>Excludes notes, self-authored documents, and files matching canonical document hashes from registered external references. The role label does not guarantee scholarly independence; verify the provenance yourself. Only selected pairs are sent; conversations, PDF bytes, and unselected materials are excluded.</p>
    {!sources.length && <p>No external sources available for comparison. Register searchable external text or PDFs in Reference Search.</p>}
    <fieldset disabled={disabled || busy || !!campaign && !!activeAttempt(campaign)}>
      <legend>Select comparison pairs (max 8)</legend>
      <label>Theory block to compare<select value={blockId} onChange={e => { setBlockId(e.target.value); setPreview(null); }}><option value="">Select</option>{snapshot.blocks.map(b => <option key={b.id} value={b.id}>Block {b.position + 1} · {b.text.slice(0, 70)}</option>)}</select></label>
      <label>External source to compare<select value={sourceId} onChange={e => { setSourceId(e.target.value); setSpanId(''); setPreview(null); }}><option value="">Select</option>{sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Source span to compare<select value={spanId} onChange={e => { setSpanId(e.target.value); setPreview(null); }}><option value="">Select</option>{spans.filter(s => s.sourceId === sourceId).map(s => <option key={s.id} value={s.id}>{spanLocation(s)} · {s.text.slice(0, 70)}</option>)}</select></label>
      <label>Theory assumptions, definitions, and scope<textarea value={theoryConditions} maxLength={2000} onChange={e => { setTheoryConditions(e.target.value); setPreview(null); }} /></label>
      <label>Source text assumptions, definitions, and scope<textarea value={referenceConditions} maxLength={2000} onChange={e => { setReferenceConditions(e.target.value); setPreview(null); }} /></label>
      <button type="button" disabled={!blockId || !spanId || !theoryConditions.trim() || !referenceConditions.trim() || pairs.length >= 8} onClick={() => {
        if (pairs.some(p => p.blockId === blockId && p.spanId === spanId)) { setError('This comparison pair is already selected.'); return; }
        setPairs(previous => [...previous, { blockId, spanId, theoryConditions, referenceConditions }]); setPreview(null);
      }}>Add external comparison pair</button>
      {pairs.map((p, i) => <p key={p.blockId + p.spanId}>Pair {i + 1}: {snapshot.blocks.find(b => b.id === p.blockId)?.text.slice(0, 60)} · {p.theoryConditions} / {p.referenceConditions} <button type="button" aria-label={`Remove external comparison pair ${i + 1}`} onClick={() => { setPairs(old => old.filter((_, index) => index !== i)); setPreview(null); }}>Remove</button></p>)}
      <button type="button" disabled={!pairs.length} onClick={() => void execute(async () => { setPreview(null); setPreview({ prepared: await prepareExternalReview(snapshot, pairs), modelId }); })}>Preview external comparison transmission</button>
    </fieldset>
    {validPreview && <section aria-label="External comparison transmission preview">
      <p>Model {modelId} · Full research criteria and {validPreview.prepared.context.pairs.length} selected pairs. Unselected theory blocks: {validPreview.prepared.context.omittedBlockCount}. Source text is untrusted data; prompt injection protection is not guaranteed.</p>
      {validPreview.prepared.context.evidence.map(e => <p key={e.citationId}>{e.citationId} · {e.name} · {spanLocation(e.span)} · {e.pdf && `Original PDF check required: formula/multi-column order not guaranteed · Pages with no text / excluded from search: ${e.pdf.emptyPages.join(', ') || 'None'}`}</p>)}
      {validPreview.prepared.context.omissions.map(o => <p key={o.sourceId}>Unselected external source: {o.omittedSpanCount} spans · Omitted ranges {JSON.stringify(o.ranges)}</p>)}
      <pre>{validPreview.prepared.request}</pre>
      <button type="button" disabled={disabled || busy || !campaign || !!campaign && !!activeAttempt(campaign)} onClick={() => void ask()}>Run external comparison with this scope</button>
    </section>}
    {running && <button type="button" onClick={() => controller.current?.abort()}>Abort external comparison</button>}
    {busy && <p role="status">Running external comparison…</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
