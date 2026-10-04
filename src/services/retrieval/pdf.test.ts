// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { importReference, loadReferenceSelection } from './references';
import { searchBM25 } from './bm25';
import { createContextBundle, withReferenceContext } from './context';
import { assembleContext } from './assembly';
import { registerPdf, processPdf } from './pdfIngestion';
import { assemblePdfPages, textFromPdfItems } from './pdfLayout';
import { decodePdfAsset } from './pdfBackup';
import type { PdfExtractionOptions } from './pdfExtraction';

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`pdf-${crypto.randomUUID()}`); target = new QaxiomDatabase(`pdf-target-${crypto.randomUUID()}`); });
afterEach(async () => { await db.delete(); await target.delete(); });
const bytes = () => new TextEncoder().encode('%PDF-1.4 fixture bytes').buffer;
const extractor = (texts: string[]) => async (_bytes: ArrayBuffer, options: PdfExtractionOptions) => {
  await options.onDocument(texts.length, 'fixture-v1', options.engineVersion !== 'fixture-v1');
  for (let index = options.savedPages.length; index < texts.length; index++) await options.onPage({ number: index + 1, text: texts[index] });
};
const register = () => registerPdf('paper.pdf', bytes(), 'external', db);
const run = (id: string, texts: string[]) => processPdf(id, new AbortController().signal, () => {}, db, extractor(texts));

describe('PDF persistence and page provenance', () => {
  it('migrates v3 references intact while allowing identical extracted text from distinct PDFs', async () => {
    const old = await importReference('old.txt', 'mass', 'external', target);
    const legacy = new Dexie(db.name);
    const tables = db.tables.filter(table => !['pdf_assets', 'review_runs', 'review_campaigns', 'embedding_spaces', 'embedding_vectors', 'embedding_manifests', 'embedding_activations', 'research_relations'].includes(table.name));
    legacy.version(3).stores(Object.fromEntries(tables.map(table => [table.name, table.name === 'references'
      ? '&id, &contentHash, createdAt, originVersionId'
      : [table.schema.primKey.src, ...table.schema.indexes.map(index => index.src)].join(',')])));
    for (const table of tables) await legacy.table(table.name).bulkAdd(await target.table(table.name).toArray());
    legacy.close(); await db.open();
    expect(db.verno).toBe(25);
    expect(await db.references.get(old.source.id)).toEqual(old.source);
    await run((await register()).asset.id, ['mass']);
    expect(await db.references.count()).toBe(2);
    expect((await importReference('same.txt', 'mass', 'external', db)).source.id).toBe(old.source.id);
  });

  it('deduplicates original bytes and rejects role changes and size violations', async () => {
    const results = await Promise.all([register(), register()]);
    expect(results.filter(result => result.duplicate)).toHaveLength(1);
    expect(await db.pdf_assets.count()).toBe(1);
    await expect(registerPdf('note.pdf', bytes(), 'note', db)).rejects.toThrow('다른 문서 종류');
    await expect(registerPdf('empty.pdf', new ArrayBuffer(0), 'external', db)).rejects.toThrow();
    await expect(registerPdf('big.pdf', new ArrayBuffer(21 * 1024 * 1024), 'external', db)).rejects.toThrow('20 MB');
  });

  it('preserves page-local line numbers and global offsets and includes page provenance in the provider payload', async () => {
    const result = await run((await register()).asset.id, ['first page', 'photon mass\nsecond line']);
    expect(result.status).toBe('ready');
    const data = await loadReferenceSelection([`pdf-${result.id}`], db);
    const hit = searchBM25(data, 'photon')[0];
    expect(hit.span.page).toBe(2);
    expect(hit.span.startLine).toBe(1);
    expect(hit.source.text.slice(hit.span.startOffset, hit.span.endOffset)).toBe(hit.span.text);
    const bundle = createContextBundle('photon', [hit.source.id], [hit]);
    expect(bundle.evidence[0].pdf?.fileHash).toBe(result.fileHash);
    expect(withReferenceContext([{ id: 'q', role: 'user', content: 'photon', timestamp: 1 }], bundle)[0].content).toContain('"page":2');
    await db.sessions.add({ id: 's', position: 0, title: 'PDF', createdAt: 1, updatedAt: 1, researchMode: 'general', selectedModel: 'gpt-6-astra' });
    await db.messages.add({ id: 'a', sessionId: 's', position: 0, role: 'assistant', content: '[[R1]]', timestamp: 1, contextBundle: bundle });
    const backup = await createWorkspaceBundle(db);
    await restoreWorkspaceBundle(backup, target);
    expect((await target.messages.get(['s', 'a']))?.contextBundle).toEqual(bundle);
    const expanded = assembleContext('photon', [hit.source.id], [hit], data);
    await db.messages.update(['s', 'a'], { contextBundle: expanded });
    await restoreWorkspaceBundle(JSON.parse(JSON.stringify(await createWorkspaceBundle(db))), target);
    expect((await target.messages.get(['s', 'a']))?.contextBundle).toEqual(expanded);
    backup.data.messages[0].contextBundle!.evidence[0].pdf!.fileHash = 'wrong-original';
    await expect(restoreWorkspaceBundle(backup, target)).rejects.toThrow('원문 참조');
  });

  it('distinguishes empty and mixed pages without inventing text', async () => {
    const empty = await run((await register()).asset.id, ['', '']);
    expect(empty.status).toBe('ocr_required');
    expect(await db.references.count()).toBe(0);
    const mixed = await registerPdf('mixed.pdf', new TextEncoder().encode('different PDF').buffer, 'external', db);
    expect((await run(mixed.asset.id, ['text', ''])).status).toBe('partial');
    const source = await db.references.get(`pdf-${mixed.asset.id}`);
    expect(source!.pdf!.pages.map(page => page.status)).toEqual(['text', 'empty']);
    expect(await db.reference_spans.count()).toBe(1);
  });

  it('keeps checkpoints on cancellation and resumes without publishing partial runs', async () => {
    const { asset } = await register();
    const controller = new AbortController();
    const cancelled = await processPdf(asset.id, controller.signal, () => {}, db, async (_bytes, options) => {
      await options.onDocument(2, 'fixture-v1', false);
      await options.onPage({ number: 1, text: 'completed' });
      controller.abort(); options.signal.throwIfAborted();
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.pages).toHaveLength(1);
    expect(await db.references.count()).toBe(0);
    const resumed = await run(asset.id, ['completed', 'resumed']);
    expect(resumed.pages.map(page => page.text)).toEqual(['completed', 'resumed']);
    expect(resumed.status).toBe('ready');
  });

  it('classifies password and parser failures while preserving original bytes', async () => {
    const { asset } = await register();
    const passwordError = new Error('password required'); passwordError.name = 'PasswordException';
    expect((await processPdf(asset.id, new AbortController().signal, () => {}, db, async () => { throw passwordError; })).status).toBe('encrypted');
    expect((await processPdf(asset.id, new AbortController().signal, () => {}, db, async () => { throw new Error('invalid PDF'); })).status).toBe('failed');
    expect((await db.pdf_assets.get(asset.id))?.bytes).toEqual(bytes());
    expect(await db.references.count()).toBe(0);
  });

  it('rolls back publication on span write failure but retains resumable checkpoints', async () => {
    const { asset } = await register();
    const failure = () => { throw new Error('quota'); };
    db.reference_spans.hook('creating', failure);
    const failed = await run(asset.id, ['text']);
    expect(failed.status).toBe('failed');
    expect(failed.pages).toHaveLength(1);
    expect(await db.references.count()).toBe(0);
    db.reference_spans.hook('creating').unsubscribe(failure);
    expect((await run(asset.id, ['text'])).status).toBe('ready');
  });

  it('prevents superseded extraction jobs from overwriting a newer run', async () => {
    const { asset } = await register();
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const first = processPdf(asset.id, new AbortController().signal, () => {}, db, async (_bytes, options) => {
      await options.onDocument(1, 'fixture-v1', true); started(); await paused;
      await options.onPage({ number: 1, text: 'obsolete' });
    });
    const rejection = expect(first).rejects.toThrow('이어받');
    await ready;
    await run(asset.id, ['current']); release(); await rejection;
    expect((await db.references.get(`pdf-${asset.id}`))?.text).toBe('current');
  });

  it('backs up original bytes and rejects corrupt page metadata, missing assets or byte hashes before replacement', async () => {
    await run((await register()).asset.id, ['mass', 'energy']);
    const backup = await createWorkspaceBundle(db);
    expect(backup.version).toBe(24);
    await restoreWorkspaceBundle(JSON.parse(JSON.stringify(backup)), target);
    expect((await createWorkspaceBundle(target)).data).toEqual(backup.data);
    expect((await target.pdf_assets.toArray())[0].bytes).toEqual(bytes());
    const invalid = structuredClone(backup);
    invalid.data.pdfAssets[0].base64 = btoa('%PDF tampered');
    await expect(restoreWorkspaceBundle(invalid, target)).rejects.toThrow('해시');
    invalid.data.pdfAssets = [];
    await expect(restoreWorkspaceBundle(invalid, target)).rejects.toThrow();
    const badPage = structuredClone(backup); badPage.data.referenceSpans[0].page = 9;
    await expect(restoreWorkspaceBundle(badPage, target)).rejects.toThrow();
    expect(await target.pdf_assets.count()).toBe(1);
  });

  it('normalizes in-flight backups to resumable state and imports genuine v3 text backups', async () => {
    const { asset } = await register();
    await db.pdf_assets.put({ ...asset, status: 'running', runId: 'old-worker' });
    const backup = await createWorkspaceBundle(db);
    expect(backup.data.pdfAssets[0].base64).toBe(btoa('%PDF-1.4 fixture bytes'));
    expect(decodePdfAsset(backup.data.pdfAssets[0]).status).toBe('cancelled');
    await restoreWorkspaceBundle(backup, target);
    expect((await target.pdf_assets.get(asset.id))?.runId).toBeNull();
    await db.pdf_assets.clear();
    await importReference('old.txt', 'v3 text', 'external', db);
    const legacy = await createWorkspaceBundle(db);
    const { pdfAssets: _pdf, ...data } = legacy.data;
    await restoreWorkspaceBundle({ ...legacy, version: 3, data }, target);
    expect(await target.pdf_assets.count()).toBe(0);
    expect((await target.references.toArray())[0].text).toBe('v3 text');
  });

  it('keeps extracted item order explicit and never joins spans across pages', () => {
    expect(textFromPdfItems([{ str: 'left', hasEOL: true }, { str: 'right' }])).toBe('left\nright');
    const result = assemblePdfPages([{ number: 1, text: 'one' }, { number: 2, text: '' }, { number: 3, text: 'three' }]);
    expect(result.spans.map(span => span.page)).toEqual([1, 3]);
    for (const span of result.spans) expect(result.text.slice(span.startOffset, span.endOffset)).toBe(span.text);
  });
});
