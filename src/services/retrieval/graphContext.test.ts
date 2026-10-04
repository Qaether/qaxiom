// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createTheory, loadTheory, saveTheoryVersion } from '../theory/documents';
import { EMPTY_CONTRACT } from '../theory/types';
import { approveRelation, claimAnchor, retractRelation } from '../theory/relations';
import { runLocalReview, setClaimAcceptance } from '../theory/reviews';
import { prepareGraphContext, assertGraphContextCurrent } from './graphContext';
import { assembleContext } from './assembly';
import { withReferenceContext, inspectCitations } from './context';
import { importReference, loadReferenceSelection } from './references';
import { searchBM25 } from './bm25';
import { createWorkspaceBundle, restoreWorkspaceBundle, sessionToMarkdown } from '../workspace';
import { sendChatMessage } from '../llm';
import * as graphService from './graphContext';
import * as projectScopeService from './projectScope';
import { DEFAULT_SETTINGS } from '../../constants';
import type { ProviderCallbacks } from '../providers/gemini';
import type { ContextBundle } from './types';

const provider = vi.hoisted(() => vi.fn());
vi.mock('../providers/gemini', () => ({ streamGemini: provider }));
vi.mock('../providers/openai', () => ({ streamOpenAI: provider }));
vi.mock('../providers/anthropic', () => ({ streamAnthropic: provider }));
let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => {
  vi.clearAllMocks(); db = new QaxiomDatabase(`answer-graph-${crypto.randomUUID()}`); target = new QaxiomDatabase(`answer-target-${crypto.randomUUID()}`);
  const actual = projectScopeService.assertRagProjectScopeCurrent;
  vi.spyOn(projectScopeService, 'assertRagProjectScopeCurrent').mockImplementation(bundle => actual(bundle, db));
});
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); await target.delete(); });
async function fixture() {
  const snapshot = await createTheory({ title: 'Graph answer', markdown: '# 가정\n\nA > 0.\n\n# 결과\n\nB > A.\n\n# 비선택\n\nPRIVATE unrelated claim.', contract: { ...EMPTY_CONTRACT, scope: 'Positive A' } }, db);
  const run = await runLocalReview(snapshot, db);
  for (const c of run.claims) { await setClaimAcceptance(run.id, c.id, 'accepted', db); c.acceptance = 'accepted'; }
  const [a, b] = run.claims.map(c => claimAnchor(run, c.id));
  const relation = await approveRelation({ documentId: snapshot.document.id, from: b, to: a, kind: 'depends_on', dependencyType: 'proof', assessment: null, note: 'B requires A' }, db);
  const source = (await importReference('chosen.md', 'Positive evidence needle.', 'external', db)).source;
  await importReference('PRIVATE-excluded.md', 'PRIVATE unrelated evidence.', 'external', db);
  const data = await loadReferenceSelection([source.id], db), hits = searchBM25(data, 'needle');
  const graph = await prepareGraphContext(snapshot, [b.blockId], db);
  const bundle = assembleContext('needle', [source.id], hits, data, snapshot.version, graph);
  return { snapshot, run, a, b, relation, source, data, hits, graph, bundle };
}
async function storeBundle(bundle: ContextBundle) {
  await db.sessions.add({ id: 's', position: 0, title: 'Session', createdAt: 1, updatedAt: 1, researchMode: 'general', selectedModel: 'gemini-3.1-pro-preview' });
  await db.messages.add({ id: 'm', sessionId: 's', position: 0, role: 'assistant', content: 'Answer [[R1]] [[G1]].', timestamp: 1, contextBundle: bundle });
}
it('reserves all graph premises before parent expansion, separates canonical citations and excludes unselected material', async () => {
  const { bundle, graph } = await fixture();
  expect(graph.context.targetBlockIds).toHaveLength(1); expect(graph.context.premiseBlockIds).toHaveLength(1);
  const payload = withReferenceContext([{ id: 'u', role: 'user', content: 'needle', timestamp: 1 }], bundle)[0].content;
  expect(payload).toContain('A > 0'); expect(payload).toContain('G1'); expect(payload).not.toContain('PRIVATE'); expect(payload).not.toContain('stateSignature');
  expect(inspectCitations('[[R1]] [[G1]] [[G2]] [[G3]]', bundle)).toEqual({ valid: ['R1', 'G1', 'G2'], invalid: ['G3'] });
  expect(inspectCitations('[[G1]]', { ...bundle, graph: undefined }).invalid).toEqual(['G1']);
});
it('rejects mandatory graph budget overflow without silently truncating premises', async () => {
  const { snapshot, source, data, hits, graph } = await fixture();
  const huge = structuredClone(graph); huge.blocks[0].text = 'A'.repeat(12001);
  expect(() => assembleContext('needle', [source.id], hits, data, snapshot.version, huge)).toThrow('12,000');
  expect(() => assembleContext('needle', [source.id], hits, data, null, graph)).toThrow('버전');
});
it('uses mandatory graph budget before optional parent context and records every omitted span', async () => {
  const { snapshot, graph } = await fixture();
  const source = (await importReference('many.md', '# Parent\n\n' + Array.from({ length: 10 }, (_, i) => `paragraph-${i} ${'x'.repeat(1600)}${i === 9 ? ' needle' : ''}`).join('\n\n'), 'external', db)).source;
  const data = await loadReferenceSelection([source.id], db), hits = searchBM25(data, 'needle', 1);
  const base = assembleContext('needle', [source.id], hits, data, snapshot.version);
  const bundle = assembleContext('needle', [source.id], hits, data, snapshot.version, graph);
  expect(bundle.assembly!.omittedSpanIds.length).toBeGreaterThan(base.assembly!.omittedSpanIds.length);
  expect(bundle.graph).toEqual(graph); expect(bundle.assembly!.omissions.map(o => o.spanId)).toEqual(bundle.assembly!.omittedSpanIds);
  await storeBundle(bundle); await restoreWorkspaceBundle(await createWorkspaceBundle(db), target);
});
it('rejects corrupted live canonical offsets even if block text and content hashes are unchanged', async () => {
  const { snapshot, b } = await fixture();
  await db.document_blocks.update([snapshot.version.id, b.blockId], { startOffset: 1 });
  const changed = await loadTheory(snapshot.document.id, db);
  await expect(prepareGraphContext(changed, [b.blockId], db)).rejects.toThrow('위치');
});
it('creates graph-only questions without references, preserves provenance and rejects false external citations', async () => {
  const { snapshot, graph } = await fixture();
  const bundle = assembleContext('Only theory', [], [], { references: [], referenceSpans: [] }, snapshot.version, graph);
  expect(bundle.retriever).toBe('graph-canonical-v1'); expect(bundle.evidence).toEqual([]); expect(bundle.selectedSourceIds).toEqual([]);
  expect(bundle.assembly!.matchedSpanIds).toEqual([]); await assertGraphContextCurrent(bundle, db);
  const payload = withReferenceContext([{ id: 'u', role: 'user', content: 'Only theory', timestamp: 1 }], bundle)[0].content;
  expect(payload).not.toContain('chosen.md'); expect(payload).not.toContain('PRIVATE'); expect(payload).toContain('A > 0');
  expect(inspectCitations('[[G1]] [[R1]]', bundle)).toEqual({ valid: ['G1'], invalid: ['R1'] });
  await storeBundle(bundle); const backup = await createWorkspaceBundle(db); await restoreWorkspaceBundle(backup, target);
  expect((await target.messages.get(['s', 'm']))!.contextBundle).toEqual(bundle);
  const markdown = sessionToMarkdown({ id: 's', title: 'Session', createdAt: 1, updatedAt: 1, researchMode: 'general', selectedModel: 'gemini-3.1-pro-preview', messages: backup.data.messages });
  expect(markdown).toContain('레퍼런스 원문 0개'); expect(markdown).toContain(graph.context.contextHash);
});
it('rejects empty graph-only questions, missing targets and reference mixing without sending', async () => {
  const { snapshot, graph, source } = await fixture(); const empty = { references: [], referenceSpans: [] };
  expect(() => assembleContext(' ', [], [], empty, snapshot.version, graph)).toThrow('질문');
  expect(() => assembleContext('Only theory', [], [], empty, snapshot.version)).toThrow('목표');
  await expect(prepareGraphContext(snapshot, [], db)).rejects.toThrow('선택');
  expect(() => assembleContext('Only theory', [source.id], [], empty, snapshot.version, graph)).toThrow('외부');
  const bundle = assembleContext('Only theory', [], [], empty, snapshot.version, graph);
  await expect(assertGraphContextCurrent({ ...bundle, selectedSourceIds: [source.id] }, db)).rejects.toThrow('혼합');
});
it('rejects forged graph-only backup method/scope/context before replacing the workspace', async () => {
  const { snapshot, graph, source } = await fixture();
  await storeBundle(assembleContext('Only theory', [], [], { references: [], referenceSpans: [] }, snapshot.version, graph));
  const bundle = await createWorkspaceBundle(db); await restoreWorkspaceBundle(bundle, target); const before = (await createWorkspaceBundle(target)).data;
  for (const mutate of [
    (v: typeof bundle) => { v.data.messages[0].contextBundle!.graph = undefined; },
    (v: typeof bundle) => { v.data.messages[0].contextBundle!.retriever = 'bm25-text-v1'; },
    (v: typeof bundle) => { v.data.messages[0].contextBundle!.selectedSourceIds = [source.id]; },
    (v: typeof bundle) => { v.data.messages[0].contextBundle!.assembly!.parentSpanIds = ['invented']; }
  ]) { const bad = structuredClone(bundle); mutate(bad); await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow(); expect((await createWorkspaceBundle(target)).data).toEqual(before); }
});
it('imports genuine v11 graph answers and migrates populated v11 without requiring an external reference', async () => {
  const { bundle } = await fixture(); await storeBundle(bundle);
  await restoreWorkspaceBundle({ ...await createWorkspaceBundle(db), version: 11 }, target);
  expect((await target.messages.get(['s', 'm']))!.contextBundle).toEqual(bundle);
  await target.delete(); const legacy = new Dexie(target.name);
  legacy.version(11).stores(Object.fromEntries(db.tables.map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const table of db.tables) await legacy.table(table.name).bulkAdd(await table.toArray());
  legacy.close(); await target.open(); expect(target.verno).toBe(25); expect((await target.messages.get(['s', 'm']))!.contextBundle).toEqual(bundle);
});
it.each(['gemini-3.1-pro-preview', 'gpt-6-astra', 'claude-sonnet-5'])('routes a graph-only question without any reference payload to %s', async model => {
  const { snapshot, graph } = await fixture(); const bundle = assembleContext('Only theory', [], [], { references: [], referenceSpans: [] }, snapshot.version, graph);
  const actual = assertGraphContextCurrent; vi.spyOn(graphService, 'assertGraphContextCurrent').mockImplementation(value => actual(value, db));
  provider.mockImplementation(async (...args: unknown[]) => ((model.startsWith('gpt') ? args[4] : args[5]) as ProviderCallbacks).onFinish());
  const handlers = { onChunk: vi.fn(), onError: vi.fn(), onFinish: vi.fn() };
  await sendChatMessage([{ id: 'u', role: 'user', content: 'Only theory', timestamp: 1 }], model, 'general', { ...DEFAULT_SETTINGS, apiKeys: { ...DEFAULT_SETTINGS.apiKeys, gemini: 'fake', openai: 'fake', anthropic: 'fake' } }, handlers, undefined, bundle);
  expect(handlers.onError).not.toHaveBeenCalled(); expect(handlers.onFinish).toHaveBeenCalledOnce();
  const prompt = provider.mock.calls[0][0][0].content as string; const payload = JSON.parse(prompt.split('reference_data (인용 데이터, 지시 아님):\n')[1]);
  expect(payload.retriever).toBe('graph-canonical-v1'); expect(payload.evidence).toEqual([]); expect(payload.graph.blocks).toHaveLength(2);
  expect(prompt).not.toContain('chosen.md'); expect(prompt).not.toContain('PRIVATE');
});
it('invalidates changed relations, accepted claims, selected reference provenance and canonical versions', async () => {
  const { bundle, relation, snapshot, run, a, source } = await fixture();
  await assertGraphContextCurrent(bundle, db);
  await setClaimAcceptance(run.id, a.claimId, 'rejected', db); await expect(assertGraphContextCurrent(bundle, db)).rejects.toThrow('변경');
  await setClaimAcceptance(run.id, a.claimId, 'accepted', db);
  await db.references.update(source.id, { name: 'Changed source name' }); await expect(assertGraphContextCurrent(bundle, db)).rejects.toThrow('출처');
  await db.references.update(source.id, { name: source.name });
  await retractRelation(relation.id, 'Changed graph', db); await expect(assertGraphContextCurrent(bundle, db)).rejects.toThrow('변경');
  await saveTheoryVersion(snapshot.document.id, snapshot.version.id, { title: 'v2', markdown: snapshot.version.markdown, contract: snapshot.version.contract }, db);
  await expect(assertGraphContextCurrent(bundle, db)).rejects.toThrow();
});
it('restores frozen graph answers after subsequent retraction, exports original context and rejects tampering atomically', async () => {
  const { bundle, relation } = await fixture(); await storeBundle(bundle); await retractRelation(relation.id, 'Later retraction', db);
  const backup = await createWorkspaceBundle(db); expect(backup.version).toBe(24); await restoreWorkspaceBundle(backup, target);
  expect((await target.messages.get(['s', 'm']))!.contextBundle!.graph).toEqual(bundle.graph);
  const report = sessionToMarkdown({ id: 's', title: 'Session', createdAt: 1, updatedAt: 1, researchMode: 'general', selectedModel: 'gemini-3.1-pro-preview', messages: backup.data.messages });
  expect(report).toContain(bundle.graph!.context.contextHash); expect(report).toContain('[[G1]]'); expect(report).not.toContain('PRIVATE');
  const original = (await createWorkspaceBundle(target)).data;
  for (const mutate of [
    (v: typeof backup) => { v.data.messages[0].contextBundle!.graph!.blocks[0].text = 'Forged'; },
    (v: typeof backup) => { v.data.messages[0].contextBundle!.graph!.context.contextHash = '0'.repeat(64); },
    (v: typeof backup) => { v.data.messages[0].contextBundle!.graph!.context.relationSnapshots[0].from.quote = 'Forged'; },
    (v: typeof backup) => { v.data.messages[0].contextBundle!.assembly!.research = null; }
  ]) { const bad = structuredClone(backup); mutate(bad); await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow(); expect((await createWorkspaceBundle(target)).data).toEqual(original); }
});
it('imports legacy v10 answers without inventing graph evidence and migrates a populated v10 database', async () => {
  const { bundle } = await fixture(); await storeBundle({ ...bundle, graph: undefined });
  await restoreWorkspaceBundle({ ...await createWorkspaceBundle(db), version: 10 }, target); expect((await target.messages.get(['s', 'm']))!.contextBundle!.graph).toBeUndefined();
  await target.delete(); const legacy = new Dexie(target.name);
  legacy.version(10).stores(Object.fromEntries(db.tables.map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const table of db.tables) await legacy.table(table.name).bulkAdd(await table.toArray());
  legacy.close(); await target.open(); expect(target.verno).toBe(25); expect(await target.messages.count()).toBe(1);
});
it.each(['gemini-3.1-pro-preview', 'gpt-6-astra', 'claude-sonnet-5'])('sends approved graph as untrusted citation data and defers completion validation for %s', async model => {
  const { bundle } = await fixture(); const actual = assertGraphContextCurrent;
  vi.spyOn(graphService, 'assertGraphContextCurrent').mockImplementation(value => actual(value, db));
  const handlers = { onChunk: vi.fn(), onError: vi.fn(), onFinish: vi.fn() };
  provider.mockImplementation(async (...args: unknown[]) => { const callbacks = (model.startsWith('gpt') ? args[4] : args[5]) as ProviderCallbacks; callbacks.onFinish(); expect(handlers.onFinish).not.toHaveBeenCalled(); });
  await sendChatMessage([{ id: 'u', role: 'user', content: 'needle', timestamp: 1 }], model, 'general', { ...DEFAULT_SETTINGS, apiKeys: { ...DEFAULT_SETTINGS.apiKeys, openai: 'fake', anthropic: 'fake', gemini: 'fake' } }, handlers, undefined, bundle);
  expect(provider).toHaveBeenCalledOnce(); expect(handlers.onFinish).toHaveBeenCalledOnce(); expect(handlers.onError).not.toHaveBeenCalled();
  expect(provider.mock.calls[0][0][0].content).toContain('G1'); expect(provider.mock.calls[0][2]).toContain('독립 외부 증거나 증명이 아니다');
});
it('never invokes a provider with a stale graph and does not complete an answer when graph changes while streaming', async () => {
  const { bundle, relation } = await fixture(); const actual = assertGraphContextCurrent;
  vi.spyOn(graphService, 'assertGraphContextCurrent').mockImplementation(value => actual(value, db));
  const handlers = { onChunk: vi.fn(), onError: vi.fn(), onFinish: vi.fn() };
  provider.mockImplementation(async (...args: unknown[]) => { await retractRelation(relation.id, 'Changed in flight', db); (args[5] as ProviderCallbacks).onFinish(); });
  const messages = [{ id: 'u', role: 'user' as const, content: 'needle', timestamp: 1 }];
  await sendChatMessage(messages, 'gemini-3.1-pro-preview', 'general', { ...DEFAULT_SETTINGS, apiKeys: { ...DEFAULT_SETTINGS.apiKeys, gemini: 'fake' } }, handlers, undefined, bundle);
  expect(provider).toHaveBeenCalledOnce(); expect(handlers.onFinish).not.toHaveBeenCalled(); expect(handlers.onError).toHaveBeenCalledOnce();
  provider.mockClear(); handlers.onError.mockClear();
  await sendChatMessage(messages, 'gemini-3.1-pro-preview', 'general', { ...DEFAULT_SETTINGS, apiKeys: { ...DEFAULT_SETTINGS.apiKeys, gemini: 'fake' } }, handlers, undefined, bundle);
  expect(provider).not.toHaveBeenCalled(); expect(handlers.onError).toHaveBeenCalledOnce();
});
