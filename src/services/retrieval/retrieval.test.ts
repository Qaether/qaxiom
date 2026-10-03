// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createTheory } from '../theory/documents';
import { EMPTY_CONTRACT } from '../theory/types';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { importReference, loadReferenceSelection, splitReference } from './references';
import { searchBM25, tokenize } from './bm25';
import { createContextBundle, inspectCitations, withReferenceContext } from './context';
import type { ChatMessage } from '../../types';

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`references-${crypto.randomUUID()}`); target = new QaxiomDatabase(`restore-${crypto.randomUUID()}`); });
afterEach(async () => { await db.delete(); await target.delete(); });

async function fixture() {
  const first = (await importReference('selected.md', '# 정의\r\n\r\n광자는 질량이 없다. photon mass\r\n\r\n# 조건\r\n\r\n진공 조건이다.', 'external', db)).source;
  const excluded = (await importReference('excluded.txt', '광자 secret_excluded_text', 'external', db)).source;
  const data = await loadReferenceSelection([first.id], db);
  const hits = searchBM25(data, '광자의 질량');
  return { first, excluded, data, hits, bundle: createContextBundle('광자의 질량', [first.id], hits) };
}

describe('text reference retrieval', () => {
  it('upgrades a populated v2 database without losing theory history', async () => {
    const theory = await createTheory({ title: 'v2 정본', markdown: '예전 연구', contract: { ...EMPTY_CONTRACT } }, target);
    const legacy = new Dexie(db.name);
    const oldTables = db.tables.filter(table => !['references', 'reference_spans', 'pdf_assets', 'review_runs', 'review_campaigns', 'embedding_spaces', 'embedding_vectors', 'embedding_manifests', 'embedding_activations', 'research_relations'].includes(table.name));
    legacy.version(2).stores(Object.fromEntries(oldTables.map(table => [table.name,
      [table.schema.primKey.src, ...table.schema.indexes.map(index => index.src)].join(', ')])));
    for (const table of oldTables) await legacy.table(table.name).bulkAdd(await target.table(table.name).toArray());
    legacy.close();
    await db.open();
    expect(db.verno).toBe(23);
    expect(await db.document_versions.get(theory.version.id)).toEqual(theory.version);
    expect(await db.document_blocks.count()).toBe(theory.blocks.length);
    expect(await db.references.count()).toBe(0);
  });

  it('imports immutable text and exact CRLF spans and deduplicates concurrent imports', async () => {
    const text = '# 제목\r\n\r\n광자 😀\r\n\r\n다른 문단';
    const results = await Promise.all([importReference('one.md', text, 'external', db), importReference('two.txt', text, 'external', db)]);
    expect(results.filter(result => result.duplicate)).toHaveLength(1);
    expect(await db.references.count()).toBe(1);
    const spans = await db.reference_spans.orderBy('[sourceId+position]').toArray();
    expect(spans.map(span => span.startLine)).toEqual([1, 3, 5]);
    for (const span of spans) expect(text.slice(span.startOffset, span.endOffset)).toBe(span.text);
    expect(spans[1].endLine).toBe(4);
  });

  it('preserves text offsets across long blocks and does not split surrogate pairs', () => {
    const text = 'a'.repeat(2399) + '😀' + 'b'.repeat(2401);
    const spans = splitReference(text);
    expect(spans.map(span => span.text).join('')).toBe(text);
    expect(spans.every(span => span.text.length <= 2400)).toBe(true);
    expect(spans[1].text.startsWith('😀')).toBe(true);
  });

  it('rolls back source and spans when ingestion fails', async () => {
    const failure = () => { throw new Error('disk full'); };
    db.reference_spans.hook('creating', failure);
    await expect(importReference('file.md', '내용', 'external', db)).rejects.toThrow('disk full');
    expect(await db.references.count()).toBe(0);
    expect(await db.reference_spans.count()).toBe(0);
  });

  it('rejects unsupported, binary, empty and oversized sources without writing', async () => {
    for (const [name, text] of [['a.pdf', '%PDF'], ['a.txt', ''], ['a.txt', '\u0000binary'], ['a.txt', '가'.repeat(700000)]]) {
      await expect(importReference(name, text, 'external', db)).rejects.toThrow();
    }
    expect(await db.references.count()).toBe(0);
  });

  it('recognizes an exact own revision and never upgrades it to independent evidence', async () => {
    const theory = await createTheory({ title: '정본', markdown: '내 가정 x > 0', contract: { ...EMPTY_CONTRACT } }, db);
    const result = await importReference('own.md', theory.version.markdown, 'external', db);
    expect(result.source.role).toBe('theory_snapshot');
    expect(result.source.originVersionId).toBe(theory.version.id);
    expect((await importReference('again.md', theory.version.markdown, 'external', db)).source.role).toBe('theory_snapshot');
  });

  it('classifies a reference as own at retrieval when the theory was saved later', async () => {
    const source = (await importReference('early.md', '같은 연구 이론', 'external', db)).source;
    await createTheory({ title: '이론', markdown: source.text, contract: { ...EMPTY_CONTRACT } }, db);
    const data = await loadReferenceSelection([source.id], db);
    expect(data.references[0].role).toBe('theory_snapshot');
    expect(data.references[0].originVersionId).toBeTruthy();
  });

  it('searches only explicitly selected sources, including Korean suffixes and English', async () => {
    const { first, hits, data } = await fixture();
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(hit => hit.source.id === first.id)).toBe(true);
    expect(hits[0].span.text).toContain('광자는 질량');
    expect(searchBM25(data, 'PHOTON')[0].span.text).toContain('photon');
    expect(searchBM25(data, 'unrelated')).toEqual([]);
    expect(tokenize('광자의')).toContain('ko:광자');
    await expect(loadReferenceSelection([], db)).rejects.toThrow('선택');
    await expect(loadReferenceSelection(['missing'], db)).rejects.toThrow('없습니다');
  });

  it('freezes evidence, separates citations and rejects stale queries or excessive budgets', async () => {
    const { bundle, hits, first } = await fixture();
    const messages: ChatMessage[] = [{ id: 'u', role: 'user', content: bundle.query, timestamp: 1 }];
    const request = withReferenceContext(messages, bundle);
    expect(request.at(-1)!.content).toContain('광자는 질량');
    expect(request.at(-1)!.content).not.toContain('secret_excluded_text');
    expect(messages[0].content).toBe(bundle.query);
    expect(inspectCitations('근거 [[R1]] [[R999]] [[R1]]', bundle)).toEqual({ valid: ['R1'], invalid: ['R999'] });
    expect(() => withReferenceContext([{ ...messages[0], content: '변경' }], bundle)).toThrow('질문이 바뀌');
    expect(() => withReferenceContext([{ ...messages[0], content: '가'.repeat(20000) }, ...messages], bundle)).toThrow('안전 한도');
    expect(() => createContextBundle('q', [first.id], Array(9).fill(hits[0]))).toThrow('8개');
    expect(() => createContextBundle('q', ['excluded'], hits)).toThrow('일치');
    hits[0].span.text = 'mutated';
    expect(bundle.evidence[0].span.text).not.toBe('mutated');
  });

  it('round-trips sources and answer context, rejecting corrupt citations before clearing data', async () => {
    const { bundle } = await fixture();
    await db.sessions.add({ id: 's', position: 0, title: '인용', createdAt: 1, updatedAt: 1, selectedModel: 'gpt-6-astra', researchMode: 'general' });
    await db.messages.add({ id: 'a', sessionId: 's', position: 0, role: 'assistant', content: '답변 [[R1]]', timestamp: 1, contextBundle: bundle });
    const backup = await createWorkspaceBundle(db);
    expect(backup.version).toBe(22);
    expect(backup.markdown[0].content).toContain('전송한 원문 근거');
    await restoreWorkspaceBundle(JSON.parse(JSON.stringify(backup)), target);
    expect((await createWorkspaceBundle(target)).data).toEqual(backup.data);
    backup.data.messages[0].contextBundle!.evidence[0].span.startOffset++;
    await expect(restoreWorkspaceBundle(backup, target)).rejects.toThrow('원문 참조');
    expect(await target.references.count()).toBe(2);
  });

  it('verifies source hashes and span offsets before restore and preserves existing references on write failure', async () => {
    await fixture();
    await importReference('keep.txt', '보존 원문', 'note', target);
    const backup = await createWorkspaceBundle(db);
    const invalid = structuredClone(backup);
    invalid.data.references[0].contentHash = 'tampered';
    await expect(restoreWorkspaceBundle(invalid, target)).rejects.toThrow();
    const badOffset = structuredClone(backup);
    badOffset.data.referenceSpans[0].startOffset++;
    await expect(restoreWorkspaceBundle(badOffset, target)).rejects.toThrow();
    const failure = () => { throw new Error('restore failed'); };
    target.reference_spans.hook('creating', failure);
    await expect(restoreWorkspaceBundle(backup, target)).rejects.toThrow('restore failed');
    expect((await target.references.toArray()).map(source => source.name)).toEqual(['keep.txt']);
  });

  it('imports genuine v2 backups and clears newer references in full replacement', async () => {
    const theory = await createTheory({ title: '이전', markdown: '보존 이론', contract: { ...EMPTY_CONTRACT } }, db);
    const backup = await createWorkspaceBundle(db);
    const { references: _r, referenceSpans: _s, ...v2Data } = backup.data;
    await importReference('keep.txt', '교체 원문', 'note', target);
    await restoreWorkspaceBundle({ ...backup, version: 2, data: v2Data }, target);
    expect(await target.references.count()).toBe(0);
    expect((await target.document_versions.get(theory.version.id))?.markdown).toBe('보존 이론');
  });
});
