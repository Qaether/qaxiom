import { useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { createEmbeddingSpace, indexEmbeddingPlan, prepareEmbeddingPlan, requestEmbeddings, embeddingBody, type EmbeddingPlan } from '../services/retrieval/embeddings';
import type { EmbeddingSpace, EmbeddingVector, EmbeddingActivation, HybridTrace } from '../services/retrieval/embeddingTypes';
import { activateGeneration, prepareGenerationActivation, loadActiveGeneration, assertActiveGeneration } from '../services/retrieval/embeddingGenerations';
import type { ReferenceData, RetrievalHit } from '../services/retrieval/types';
import { spanLocation } from '../services/retrieval/pdfTypes';
import { assertEmbeddingScopeCurrent, captureEmbeddingScope, type EmbeddingProjectScope } from '../services/retrieval/embeddingScope';

export default function SemanticRetrieval({ selected, query, researchVersionId, projectId, apiKey, busy, onBusy, onResults }: {
  selected: string[]; query: string; apiKey: string; busy: boolean; onBusy: (busy: boolean) => void;
  researchVersionId: string;
  projectId: string;
  onResults: (hits: RetrievalHit[], data: ReferenceData, trace: HybridTrace) => void;
}) {
  const [space, setSpace] = useState<EmbeddingSpace | null>(null);
  const [spaces, setSpaces] = useState<EmbeddingSpace[]>([]);
  const [sealedIds, setSealedIds] = useState<string[]>([]);
  const [activeGeneration, setActiveGeneration] = useState<EmbeddingActivation | null>(null);
  const [savedActivation, setActivation] = useState<(Awaited<ReturnType<typeof prepareGenerationActivation>> & { scopeKey: string; projectScope: EmbeddingProjectScope | null }) | null>(null);
  const [savedPlan, setPlan] = useState<(EmbeddingPlan & { scopeKey: string }) | null>(null);
  const [savedQueryPreview, setQueryPreview] = useState<{ scopeKey: string; query: string; data: ReferenceData; vectors: EmbeddingVector[]; space: EmbeddingSpace; activation: EmbeddingActivation; projectScope: EmbeddingProjectScope | null } | null>(null);
  const [maxRequests, setMaxRequests] = useState(3);
  const [error, setError] = useState(''); const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null), worker = useRef<Worker | null>(null);
  const scopeKey = JSON.stringify([selected, query, maxRequests, researchVersionId, projectId]);
  const plan = savedPlan?.scopeKey === scopeKey && savedPlan.space.id === space?.id ? savedPlan : null;
  const activationPreview = savedActivation?.scopeKey === scopeKey && savedActivation.manifest.spaceId === space?.id ? savedActivation : null;
  const queryPreview = savedQueryPreview?.scopeKey === scopeKey && savedQueryPreview.activation.revision === activeGeneration?.revision ? savedQueryPreview : null;
  const refresh = async () => {
    const [all, manifests, active] = await Promise.all([qaxiomDatabase.embedding_spaces.orderBy('createdAt').reverse().toArray(),
      qaxiomDatabase.embedding_manifests.toArray(), qaxiomDatabase.embedding_activations.get('active')]);
    return { all, manifests, active };
  };
  const update = (value: Awaited<ReturnType<typeof refresh>>) => {
    setSpaces(value.all); setSealedIds(value.manifests.map(m => m.spaceId)); setActiveGeneration(value.active ?? null);
    setSpace(previous => previous ?? value.all[0] ?? null);
  };
  useEffect(() => {
    let active = true;
    const poll = () => void refresh().then(value => { if (active) update(value); }).catch(() => { if (active) setError('Failed to load the semantic index list.'); });
    poll(); const timer = window.setInterval(poll, 2000);
    return () => { active = false; window.clearInterval(timer); abort.current?.abort(); worker.current?.terminate(); };
  }, []);
  const execute = async (task: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController(); abort.current = controller; onBusy(true); setRunning(true); setError('');
    try { await task(controller.signal); }
    catch (cause) { setError(controller.signal.aborted ? 'Aborted. Completed and saved spans are preserved and will not be resent automatically. Provider cost is unconfirmed.' : cause instanceof Error ? cause.message : 'Semantic search failed.'); }
    finally { try { update(await refresh()); } catch { setError('Failed to load the semantic index list.'); } abort.current = null; setRunning(false); onBusy(false); }
  };
  return <section aria-label="Semantic Search" className="reference-hit">
    <h3>Optional Semantic Search — OpenAI Embeddings + BM25</h3>
    <p>OpenAI text-embedding-3-small · 512 dims · Index generation {space?.id ?? 'None'} · Provider internal revision unconfirmed. Source indexing and query embedding require separate approval and make paid API requests. Original PDFs, conversations, and research contracts are not sent to the embedding provider.</p>
    <p>Vectors are stored in local IndexedDB. Only identical generation, source, and span hashes are reused; vectors are never mixed across generations. A new generation preserves previous indices but incurs re-indexing cost.</p>
    <p>{researchVersionId ? 'Canonical-scoped semantic search: verifies the current project’s source policy, membership, and canonical document before and after indexing or sending queries.' : projectId ? 'Project-scoped semantic search: verifies the selected project’s source policy before and after indexing or sending queries. No canonical document is attached.' : 'Semantic search without a selected project or canonical document applies workspace-wide.'} Only the currently selected sources from the shared index are used.</p>
    <p>Active search generation: {activeGeneration?.spaceId ?? 'None'} · Transition #{activeGeneration?.revision ?? 0}. Creating or aborting a new generation keeps the current active generation intact. Hash verification of all extracted spans and separate activation approval are required. Active status indicates search readiness, not theoretical consistency.</p>
    {!apiKey.trim() && <p>Semantic search requires an OpenAI API key in Settings. Standard full-text search (BM25) remains available without a key.</p>}
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    <fieldset disabled={busy}>
      <legend>Source Indexing Approval</legend>
      <label>Target Index Generation<select value={space?.id ?? ''} onChange={event => { setSpace(spaces.find(s => s.id === event.target.value) ?? null); setPlan(null); setActivation(null); }}>
        {!spaces.length && <option value="">None</option>}
        {spaces.map(s => <option key={s.id} value={s.id}>{s.id} · {sealedIds.includes(s.id) ? 'Sealed · Read-only' : 'Draft / Unverified'}{activeGeneration?.spaceId === s.id ? ' · Active' : ''}</option>)}
      </select></label>
      <label>Max Requests for This Indexing Run<input type="number" min={1} max={100} value={maxRequests} onChange={event => setMaxRequests(Number(event.target.value))} /></label>
      <button type="button" onClick={() => void execute(async () => { setSpace(await createEmbeddingSpace()); setPlan(null); setActivation(null); })}>Create New Local Index Generation</button>
      <button type="button" disabled={!selected.length} onClick={() => void execute(async () => {
        const current = space ?? await createEmbeddingSpace(); setSpace(current);
        setPlan({ ...await prepareEmbeddingPlan(current.id, selected, maxRequests, qaxiomDatabase, researchVersionId, projectId), scopeKey }); setQueryPreview(null);
      })}>Preview Embedding Transfer</button>
      <button type="button" disabled={!space || !selected.length} onClick={() => void execute(async () => {
        if (space) {
          const prepared = await prepareGenerationActivation(space.id, selected);
          const projectScope = await captureEmbeddingScope(researchVersionId, prepared.manifest.sources.map(s => s.id), qaxiomDatabase, projectId);
          setActivation({ ...prepared, scopeKey, projectScope });
        }
      })}>Preview Sealed Generation Activation</button>
    </fieldset>
    {activationPreview && <section aria-label="Index Activation Preview">
      {activationPreview.projectScope && <p>Project {activationPreview.projectScope.projectId} · Policy {activationPreview.projectScope.policyScope ?? 'Unset'} · Revision {activationPreview.projectScope.policyRevision ?? 'None'} · SHA-256 {activationPreview.projectScope.policyHash ?? 'None'}</p>}
      <p>Generation to activate {activationPreview.manifest.spaceId} · {activationPreview.manifest.sources.length} sources / {activationPreview.manifest.spans.length} spans · SHA-256 {activationPreview.manifest.manifestHash}</p>
      {activationPreview.data.references.map(s => <p key={s.id}>{s.name} · {s.contentHash}{s.pdf ? ` · Excluded pages: ${s.pdf.pages.filter(p => p.status === 'empty').map(p => p.number).join(', ') || 'None'}` : ''}</p>)}
      <p>This local switch makes no API calls. Sealed generations are locked read-only and previous generations are preserved. Textless PDF pages are excluded from search regardless of whether all extracted spans are complete.</p>
      <button type="button" disabled={busy} onClick={() => void execute(async () => {
        await assertEmbeddingScopeCurrent(activationPreview.projectScope, activationPreview.manifest.sources.map(s => s.id));
        await activateGeneration(activationPreview, qaxiomDatabase, activationPreview.projectScope); setActivation(null); setPlan(null); setQueryPreview(null);
        setStatus('Verified sealed generation activated. This indicates search readiness, not consistency verification.');
      })}>Approve Activation of This Sealed Generation</button>
    </section>}
    {plan && <section aria-label="Source Embedding Transfer Preview">
      {plan.projectScope && <p>{plan.projectScope.versionId ? 'Canonical' : 'Selected'} project {plan.projectScope.projectId} · Policy {plan.projectScope.policyScope ?? 'Unset'} · Revision {plan.projectScope.policyRevision ?? 'None'} · SHA-256 {plan.projectScope.policyHash ?? 'None'}. Other allowed sources in the policy will not be sent.</p>}
      <p>OpenAI {plan.space.model} · {plan.space.dimensions} dims · Generation {plan.space.id} · Max {plan.batches.length} requests / 120s. Only the new span texts below will be sent; filenames and pages are shown here for source verification. Token limits and monetary costs are not estimated.</p>
      <p>Cached {plan.cached} spans · Sending {plan.batches.flat().length} spans · Omitted by budget {plan.omitted.length} spans. Omitted spans remain searchable via BM25, though semantic indexing is incomplete.</p>
      {plan.data.references.filter(source => source.pdf).map(source => <p key={source.id}>{source.name} · Textless pages: {source.pdf!.pages.filter(p => p.status === 'empty').map(p => p.number).join(', ') || 'None'}. These pages are excluded from both search modes.</p>)}
      {plan.batches.flat().map(span => <div key={span.id}><p>{plan.data.references.find(source => source.id === span.sourceId)?.name} · {spanLocation(span)} · {span.contentHash}</p><pre>{span.text}</pre></div>)}
      {!!plan.omitted.length && <details><summary>Spans omitted from this indexing run</summary>{plan.omitted.map(span => <p key={span.id}>{plan.data.references.find(s => s.id === span.sourceId)?.name} · {spanLocation(span)} · {span.id}</p>)}</details>}
      <button type="button" disabled={busy || !apiKey.trim() || !plan.batches.length} onClick={() => void execute(async signal => {
        await indexEmbeddingPlan(plan, apiKey, signal, (count, tokens) => setStatus(`Saved ${count} spans in this run · Last successful response prompt_tokens ${tokens ?? 'unconfirmed'} (not cumulative cost)`));
        setPlan(null); setStatus('Approved indexing job saved. To index remaining spans, generate a new preview and approve explicitly.');
      })}>Approve Embedding Generation for These Sources</button>
    </section>}
    <fieldset disabled={busy}>
      <legend>Query Embedding Approval</legend>
      <button type="button" disabled={!selected.length || !query.trim()} onClick={() => void execute(async () => {
        const projectScope = await captureEmbeddingScope(researchVersionId, selected, qaxiomDatabase, projectId);
        const active = await loadActiveGeneration(selected);
        embeddingBody(active.space, [query]);
        await assertEmbeddingScopeCurrent(projectScope, selected);
        setQueryPreview({ scopeKey, query, ...active, projectScope }); setPlan(null);
      })}>Preview Semantic Search Query Transfer</button>
    </fieldset>
    {queryPreview && <section aria-label="Query Embedding Transfer Preview">
      {queryPreview.projectScope && <p>{queryPreview.projectScope.versionId ? 'Canonical' : 'Selected'} project {queryPreview.projectScope.projectId} · Policy {queryPreview.projectScope.policyScope ?? 'Unset'} · Revision {queryPreview.projectScope.policyRevision ?? 'None'} · SHA-256 {queryPreview.projectScope.policyHash ?? 'None'}</p>}
      <p>OpenAI {queryPreview.space.model} · {queryPreview.space.dimensions} dims · Generation {queryPreview.space.id} · Only the query below will be sent once. No source texts are included in this request.</p>
      <pre>{queryPreview.query}</pre>
      <p>Semantically indexed {queryPreview.vectors.length}/{queryPreview.data.referenceSpans.length} spans · Unindexed {queryPreview.data.referenceSpans.length - queryPreview.vectors.length} spans are excluded from semantic search but still searched by BM25. Results are fused with RRF (k=60) and represent relevance candidates, not consistency or truth probability.</p>
      <button type="button" disabled={busy || !apiKey.trim()} onClick={() => void execute(async signal => {
        await assertEmbeddingScopeCurrent(queryPreview.projectScope, selected);
        await assertActiveGeneration(queryPreview.activation, queryPreview.data); signal.throwIfAborted();
        const response = await requestEmbeddings(queryPreview.space, [queryPreview.query], apiKey, AbortSignal.any([signal, AbortSignal.timeout(30000)]));
        signal.throwIfAborted();
        await assertEmbeddingScopeCurrent(queryPreview.projectScope, selected);
        const searchWorker = new Worker(new URL('../services/retrieval/search.worker.ts', import.meta.url), { type: 'module' }); worker.current = searchWorker;
        const hits = await new Promise<RetrievalHit[]>((resolve, reject) => {
          const stop = () => { searchWorker.terminate(); reject(new Error('Search aborted')); };
          signal.addEventListener('abort', stop, { once: true });
          searchWorker.onmessage = event => { signal.removeEventListener('abort', stop); searchWorker.terminate(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.hits); };
          searchWorker.onerror = () => { signal.removeEventListener('abort', stop); searchWorker.terminate(); reject(new Error('Semantic search worker failed')); };
          searchWorker.postMessage({ data: queryPreview.data, query: queryPreview.query, hybrid: { space: queryPreview.space, vectors: queryPreview.vectors, queryVector: response.vectors[0] } });
        });
        worker.current = null;
        await assertActiveGeneration(queryPreview.activation, queryPreview.data); signal.throwIfAborted();
        await assertEmbeddingScopeCurrent(queryPreview.projectScope, selected);
        const covered = new Set(queryPreview.vectors.map(v => v.spanId));
        onResults(hits, queryPreview.data, { spaceId: queryPreview.space.id, model: queryPreview.space.model, dimensions: queryPreview.space.dimensions,
          adapterVersion: queryPreview.space.adapterVersion, providerRevision: null, coveredSpanIds: [...covered], missingSpanIds: queryPreview.data.referenceSpans.filter(s => !covered.has(s.id)).map(s => s.id),
          manifestHash: queryPreview.activation.manifestHash, activationRevision: queryPreview.activation.revision });
        setQueryPreview(null); setStatus(`Semantic/BM25 results: ${hits.length} · Query prompt_tokens ${response.promptTokens ?? 'unconfirmed'}. Sending to a response provider requires selecting evidence, previewing, and separate approval.`);
      })}>Approve Semantic Search with This Query</button>
    </section>}
    {running && <button type="button" onClick={() => abort.current?.abort()}>Abort Semantic Search Task</button>}
  </section>;
}
