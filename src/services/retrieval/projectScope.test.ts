// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { qaxiomDatabase as db, QaxiomDatabase } from '../database';
import { createTheory, saveTheoryVersion } from '../theory/documents';
import { EMPTY_CONTRACT } from '../theory/types';
import { saveProjectSources } from '../theory/projectSources';
import { moveTheoryProject } from '../theory/projects';
import { importReference, loadReferenceSelection } from './references';
import { assembleContext } from './assembly';
import { searchBM25 } from './bm25';
import { assertRagProjectScopeCurrent, assertRagSearchScope, prepareRagProjectScope } from './projectScope';
import { withReferenceContext } from './context';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { sendChatMessage } from '../llm';
import { DEFAULT_SETTINGS } from '../../constants';
import { prepareGraphContext } from './graphContext';
import type { ProviderCallbacks } from '../providers/gemini';

const provider = vi.hoisted(() => vi.fn());
vi.mock('../providers/gemini', () => ({ streamGemini: provider }));
vi.mock('../providers/openai', () => ({ streamOpenAI: provider }));
vi.mock('../providers/anthropic', () => ({ streamAnthropic: provider }));
let target: QaxiomDatabase;
beforeEach(async () => { vi.clearAllMocks(); await db.delete(); await db.open(); target = new QaxiomDatabase(`scope-target-${crypto.randomUUID()}`); });
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); await target.delete(); });
async function fixture() {
  const snapshot = await createTheory({ title: 'Scope', markdown: 'Canonical theory.', contract: EMPTY_CONTRACT }, db);
  const a = (await importReference('chosen.md', 'needle selected original.', 'external', db)).source;
  const b = (await importReference('PRIVATE.md', 'PRIVATE unselected original.', 'external', db)).source;
  const data = await loadReferenceSelection([a.id], db);
  const bundle = assembleContext('needle', [a.id], searchBM25(data, 'needle'), data, snapshot.version);
  return { snapshot, a, b, bundle };
}
const messages = [{ id: 'u', role: 'user' as const, content: 'needle', timestamp: 1 }];
const settings = { ...DEFAULT_SETTINGS, apiKeys: { ...DEFAULT_SETTINGS.apiKeys, gemini: 'fake', openai: 'fake', anthropic: 'fake' } };
const callbacks = () => ({ onChunk: vi.fn(), onError: vi.fn(), onFinish: vi.fn() });
it('keeps legacy and external-only policies explicit, without silently restricting canonical RAG', async () => {
  const f = await fixture(); await assertRagProjectScopeCurrent(f.bundle, db);
  await saveProjectSources(f.snapshot, null, [], db);
  const prepared = await prepareRagProjectScope(f.bundle, db);
  expect(prepared.projectScope!.policyScope).toBe('external_review');
  await assertRagProjectScopeCurrent(prepared, db);
  await assertRagSearchScope(f.snapshot.version.id, [f.b.id], db);
});
it('enforces the full selected range before search and preview, and never sends unselected policy IDs', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id, f.b.id], db, 'research');
  const prepared = await prepareRagProjectScope(f.bundle, db);
  const payload = withReferenceContext(messages, prepared)[0].content;
  expect(payload).not.toContain(f.b.id); expect(payload).not.toContain('PRIVATE'); expect(payload).not.toContain('allowedSourceIds');
  await saveProjectSources(f.snapshot, 1, [f.a.id], db, 'research');
  await expect(assertRagSearchScope(f.snapshot.version.id, [f.a.id, f.b.id], db)).rejects.toThrow('허용 목록');
  await expect(prepareRagProjectScope({ ...f.bundle, selectedSourceIds: [f.a.id, f.b.id] }, db)).rejects.toThrow('허용 목록');
});
it('denies pre-policy previews and empty research lists before any adapter call', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id], db, 'research');
  const cb = callbacks(); await sendChatMessage(messages, 'gemini-3.1-pro-preview', 'general', settings, cb, undefined, f.bundle);
  expect(provider).not.toHaveBeenCalled(); expect(cb.onError).toHaveBeenCalled();
  await saveProjectSources(f.snapshot, 1, [], db, 'research');
  await expect(prepareRagProjectScope(f.bundle, db)).rejects.toThrow('허용 목록');
});
it('permits explicitly selected canonical-only context with an empty research allow-list', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [], db, 'research');
  const graph = await prepareGraphContext(f.snapshot, [f.snapshot.blocks[0].id], db);
  const canonical = assembleContext('Only canonical', [], [], { references: [], referenceSpans: [] }, f.snapshot.version, graph);
  const prepared = await prepareRagProjectScope(canonical, db);
  expect(prepared.evidence).toEqual([]); expect(prepared.projectScope!.policyScope).toBe('research');
  await assertRagProjectScopeCurrent(prepared, db);
});
it('invalidates even still-allowed policy revisions, project moves and canonical versions', async () => {
  const f = await fixture(), prepared = await prepareRagProjectScope(f.bundle, db);
  await saveProjectSources(f.snapshot, null, [f.a.id], db, 'research');
  await expect(assertRagProjectScopeCurrent(prepared, db)).rejects.toThrow('변경');
  const beforeMove = await prepareRagProjectScope(f.bundle, db);
  const split = await moveTheoryProject(f.snapshot, { newTitle: 'Split' }, db);
  await expect(assertRagProjectScopeCurrent(beforeMove, db)).rejects.toThrow('변경');
  const beforeVersion = await prepareRagProjectScope(f.bundle, db);
  await saveTheoryVersion(split.document.id, split.version.id, { title: 'Scope', markdown: 'New canonical.', contract: EMPTY_CONTRACT }, db);
  await expect(assertRagProjectScopeCurrent(beforeVersion, db)).rejects.toThrow('변경');
});
it.each(['gemini-3.1-pro-preview', 'gpt-6-astra', 'claude-sonnet-5'])('withholds successful completion after in-flight revocation for %s', async model => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id], db, 'research');
  const prepared = await prepareRagProjectScope(f.bundle, db), cb = callbacks();
  provider.mockImplementationOnce(async (...args: unknown[]) => {
    const handlers = args.find(a => !!a && typeof a === 'object' && 'onFinish' in a) as ProviderCallbacks;
    handlers.onChunk('partial'); await saveProjectSources(f.snapshot, 1, [], db, 'research'); handlers.onFinish();
  });
  await sendChatMessage(messages, model, 'general', settings, cb, undefined, prepared);
  expect(provider).toHaveBeenCalledOnce(); expect(cb.onChunk).toHaveBeenCalledWith('partial');
  expect(cb.onFinish).not.toHaveBeenCalled(); expect(cb.onError).toHaveBeenCalled();
});
it('detects in-flight activation even for legacy bundles without scope metadata', async () => {
  const f = await fixture(), cb = callbacks();
  provider.mockImplementationOnce(async (...args: unknown[]) => {
    await saveProjectSources(f.snapshot, null, [f.a.id], db, 'research');
    (args.find(a => !!a && typeof a === 'object' && 'onFinish' in a) as ProviderCallbacks).onFinish();
  });
  await sendChatMessage(messages, 'gemini-3.1-pro-preview', 'general', settings, cb, undefined, f.bundle);
  expect(cb.onFinish).not.toHaveBeenCalled(); expect(cb.onError).toHaveBeenCalled();
});
it('completes an unchanged approved scope and rejects tampered evidence/criteria', async () => {
  const f = await fixture(), prepared = await prepareRagProjectScope(f.bundle, db), cb = callbacks();
  provider.mockImplementationOnce(async (...args: unknown[]) => (args.find(a => !!a && typeof a === 'object' && 'onFinish' in a) as ProviderCallbacks).onFinish());
  await sendChatMessage(messages, 'gemini-3.1-pro-preview', 'general', settings, cb, undefined, prepared);
  expect(cb.onFinish).toHaveBeenCalledOnce(); expect(cb.onError).not.toHaveBeenCalled();
  const bad = structuredClone(prepared); bad.assembly!.research!.contract.scope = 'forged';
  await expect(assertRagProjectScopeCurrent(bad, db)).rejects.toThrow('연구');
  const evidence = structuredClone(prepared); evidence.evidence[0].span.text = 'forged';
  await expect(assertRagProjectScopeCurrent(evidence, db)).rejects.toThrow('원문');
});
it('roundtrips frozen scope independently of later policy changes and preserves data on invalid restore', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id], db, 'research');
  const prepared = await prepareRagProjectScope(f.bundle, db);
  await db.sessions.add({ id: 's', title: 'Scope', position: 0, createdAt: 1, updatedAt: 1, researchMode: 'general', selectedModel: 'gemini-3.1-pro-preview' });
  await db.messages.add({ id: 'm', sessionId: 's', position: 0, role: 'assistant', content: 'Answer [[R1]]', timestamp: 1, contextBundle: prepared });
  await saveProjectSources(f.snapshot, 1, [], db, 'research');
  const backup = await createWorkspaceBundle(db); await restoreWorkspaceBundle(backup, target);
  expect((await target.messages.get(['s', 'm']))!.contextBundle!.projectScope).toEqual(prepared.projectScope);
  const bad = structuredClone(backup); bad.data.messages[0].contextBundle!.projectScope!.policyHash = 'invalid';
  await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow('범위'); expect(await target.messages.count()).toBe(1);
});
it('applies an explicit project without attaching a canonical contract or sending other allowed sources', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id, f.b.id], db, 'research');
  const data = await loadReferenceSelection([f.a.id], db);
  const standalone = assembleContext('needle', [f.a.id], searchBM25(data, 'needle'), data);
  const prepared = await prepareRagProjectScope(standalone, db, f.snapshot.document.projectId);
  expect(prepared.assembly!.research).toBeNull(); expect(prepared.projectScope!.mode).toBe('project_only');
  await assertRagProjectScopeCurrent(prepared, db);
  const wire = withReferenceContext(messages, prepared)[0].content;
  expect(wire).not.toContain(f.b.id); expect(wire).not.toContain('PRIVATE'); expect(wire).not.toContain('Canonical theory');
  await db.sessions.add({ id: 's', title: 'Project', position: 0, createdAt: 1, updatedAt: 1, researchMode: 'general', selectedModel: 'gemini-3.1-pro-preview' });
  await db.messages.add({ id: 'm', sessionId: 's', position: 0, role: 'assistant', content: '[[R1]]', timestamp: 1, contextBundle: prepared });
  const backup = await createWorkspaceBundle(db); await restoreWorkspaceBundle(backup, target);
  expect((await target.messages.get(['s', 'm']))!.contextBundle!.projectScope).toEqual(prepared.projectScope);
  const bad = structuredClone(backup); bad.data.messages[0].contextBundle!.projectScope!.mode = undefined;
  await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow();
  expect(await target.messages.count()).toBe(1);
});
it('rejects project-only search and stale previews after policy revisions or a project is removed', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id], db, 'research');
  await expect(assertRagSearchScope('', [f.a.id, f.b.id], db, f.snapshot.document.projectId)).rejects.toThrow('허용 목록');
  const data = await loadReferenceSelection([f.a.id], db);
  const bundle = assembleContext('needle', [f.a.id], searchBM25(data, 'needle'), data);
  const prepared = await prepareRagProjectScope(bundle, db, f.snapshot.document.projectId);
  await saveProjectSources(f.snapshot, 1, [f.a.id], db, 'research');
  await expect(assertRagProjectScopeCurrent(prepared, db)).rejects.toThrow('변경');
  const current = await prepareRagProjectScope(bundle, db, f.snapshot.document.projectId);
  await moveTheoryProject(f.snapshot, { newTitle: 'Moved' }, db);
  await expect(assertRagProjectScopeCurrent(current, db)).rejects.toThrow('변경');
});
it('keeps external-review-only project policy out of project-only RAG and rejects mixed canonical scopes', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [], db);
  const data = await loadReferenceSelection([f.a.id], db);
  const standalone = assembleContext('needle', [f.a.id], searchBM25(data, 'needle'), data);
  const prepared = await prepareRagProjectScope(standalone, db, f.snapshot.document.projectId);
  expect(prepared.projectScope?.policyScope).toBe('external_review');
  await assertRagProjectScopeCurrent(prepared, db);
  await expect(prepareRagProjectScope(f.bundle, db, f.snapshot.document.projectId)).rejects.toThrow('동시에');
});
it('does not finish a project-only answer when its policy is revoked during the provider request', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id], db, 'research');
  const data = await loadReferenceSelection([f.a.id], db);
  const bundle = await prepareRagProjectScope(assembleContext('needle', [f.a.id], searchBM25(data, 'needle'), data), db, f.snapshot.document.projectId);
  const cb = callbacks();
  provider.mockImplementationOnce(async (...args: unknown[]) => {
    const handlers = args.find(a => !!a && typeof a === 'object' && 'onFinish' in a) as ProviderCallbacks;
    handlers.onChunk('unverified partial'); await saveProjectSources(f.snapshot, 1, [], db, 'research'); handlers.onFinish();
  });
  await sendChatMessage(messages, 'gemini-3.1-pro-preview', 'general', settings, cb, undefined, bundle);
  expect(provider).toHaveBeenCalledOnce(); expect(cb.onFinish).not.toHaveBeenCalled();
  expect(cb.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('완료 처리하지 않습니다') }));
});
it('imports genuine v18 backups and migrates populated v18 projects without inventing a scope', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [f.a.id], db, 'research');
  const backup = await createWorkspaceBundle(db);
  await restoreWorkspaceBundle({ ...backup, version: 18 }, target);
  expect((await target.projects.get(f.snapshot.document.projectId))!.sourcePolicy?.scope).toBe('research');
  await target.delete(); const legacy = new Dexie(target.name);
  legacy.version(18).stores(Object.fromEntries(db.tables.map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const table of db.tables) await legacy.table(table.name).bulkAdd(await table.toArray());
  legacy.close(); await target.open(); expect(target.verno).toBe(23);
  expect((await target.projects.get(f.snapshot.document.projectId))!.sourcePolicy?.scope).toBe('research');
});
it('migrates populated v17 policies/backups without expanding external-only scope', async () => {
  const f = await fixture(); await saveProjectSources(f.snapshot, null, [], db);
  const backup = await createWorkspaceBundle(db); await restoreWorkspaceBundle({ ...backup, version: 17 }, target);
  expect((await target.projects.get(f.snapshot.document.projectId))!.sourcePolicy!.scope).toBe('external_review');
  await target.delete(); const legacy = new Dexie(target.name);
  legacy.version(17).stores(Object.fromEntries(db.tables.map(t => [t.name, [t.schema.primKey.src, ...t.schema.indexes.map(i => i.src)].join(',')])));
  for (const t of db.tables) await legacy.table(t.name).bulkAdd(await t.toArray()); legacy.close(); await target.open();
  expect(target.verno).toBe(23); expect((await target.projects.get(f.snapshot.document.projectId))!.sourcePolicy!.scope).toBe('external_review');
});
