import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QaxiomDatabase } from '../database';
import { buildBlocks, compareBlocks, splitMarkdown } from './blocks';
import { createTheory, loadTheory, restoreTheoryVersion, saveTheoryVersion } from './documents';
import { EMPTY_CONTRACT } from './types';

let db: QaxiomDatabase;
const input = () => ({ title: '새 이론', markdown: '# 정의\n\nA는 양수다.\n\n# 결론\n\nA > 0', contract: { ...EMPTY_CONTRACT, purpose: '정합성 연구' } });
beforeEach(() => { db = new QaxiomDatabase(`theory-${crypto.randomUUID()}`); });
afterEach(async () => { await db.delete(); });

describe('canonical theory revisions', () => {
  it('upgrades an actual v1 database without changing old tables or records', async () => {
    const legacy = new Dexie(db.name);
    legacy.version(1).stores({
      sessions: '&id, position, updatedAt, createdAt', messages: '[sessionId+id], sessionId, [sessionId+position], timestamp',
      documents: '&id, updatedAt, createdAt, status', document_chunks: '&id, documentId, [documentId+position]',
      wiki_pages: '&id, updatedAt, *tags', source_spans: '&id, documentId, messageId, wikiPageId',
      jobs: '&id, status, updatedAt', metadata: '&key'
    });
    const old = { id: 'legacy', position: 0, title: '기존 대화', createdAt: 1, updatedAt: 1 };
    await legacy.table('sessions').add(old);
    await legacy.table('metadata').add({ key: 'legacy_sessions_v1', sourceCount: 1, completedAt: 1 });
    legacy.close();
    await db.open();
    expect(db.verno).toBe(25);
    expect(await db.sessions.get('legacy')).toEqual({ ...old, documentId: null });
    expect(await db.metadata.count()).toBe(1);
    expect(await db.document_versions.count()).toBe(0);
  });

  it('preserves old content and contract, stable block IDs, and ancestry across edits and restoration', async () => {
    const first = await createTheory(input(), db);
    const second = await saveTheoryVersion(first.document.id, first.version.id, {
      ...input(), markdown: input().markdown.replace('A는 양수다.', 'A는 1보다 크다.'),
      contract: { ...EMPTY_CONTRACT, purpose: '수정 연구', assumptions: 'A > 1' }
    }, db);
    expect(second.version.number).toBe(2);
    expect(second.version.parentVersionId).toBe(first.version.id);
    expect(second.blocks.map(block => block.id)).toEqual(first.blocks.map(block => block.id));
    expect(compareBlocks(first.blocks, second.blocks).filter(block => block.change === 'changed')).toHaveLength(1);
    expect(await db.document_versions.get(first.version.id)).toEqual(first.version);
    const restored = await restoreTheoryVersion(first.document.id, second.version.id, first.version.id, db);
    expect(restored.history).toHaveLength(3);
    expect(restored.version.markdown).toBe(first.version.markdown);
    expect(restored.version.contract).toEqual(first.version.contract);
    expect(restored.version.restoredFromVersionId).toBe(first.version.id);
    expect(restored.version.parentVersionId).toBe(second.version.id);
  });

  it('rejects one of two competing revisions and keeps the committed document intact', async () => {
    const first = await createTheory(input(), db);
    const results = await Promise.allSettled(['작업 A', '작업 B'].map(title =>
      saveTheoryVersion(first.document.id, first.version.id, { ...input(), title }, db)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const current = await loadTheory(first.document.id, db);
    expect(current.version.number).toBe(2);
    expect(current.history).toHaveLength(2);
    await expect(saveTheoryVersion(first.document.id, first.version.id, input(), db)).rejects.toThrow('다른 작업');
  });

  it('rolls back version, blocks and current pointer if a block write fails', async () => {
    const first = await createTheory(input(), db);
    const failure = () => { throw new Error('injected write failure'); };
    db.document_blocks.hook('creating', failure);
    await expect(saveTheoryVersion(first.document.id, first.version.id, { ...input(), markdown: '수정한 본문' }, db)).rejects.toThrow('injected');
    db.document_blocks.hook('creating').unsubscribe(failure);
    expect(await loadTheory(first.document.id, db)).toEqual(first);
  });

  it('does not create duplicate revisions for an unchanged save', async () => {
    const first = await createTheory(input(), db);
    expect((await saveTheoryVersion(first.document.id, first.version.id, input(), db)).version.id).toBe(first.version.id);
  });

  it('keeps fenced equations and code together with exact CRLF offsets', () => {
    const markdown = '# 제목\r\n\r\n```ts\r\na\r\n\r\nb\r\n```\r\n\r\n$$\r\nx = y\r\n\r\n+ z\r\n$$\r\n';
    const parts = splitMarkdown(markdown);
    expect(parts.map(part => part.kind)).toEqual(['heading', 'code', 'math']);
    for (const part of parts) expect(markdown.slice(part.startOffset, part.endOffset)).toBe(part.text);
  });

  it('retains unaffected IDs after insertion and records split-block predecessors', async () => {
    const first = await buildBlocks('# 시작\n\n원문 하나\n\n# 끝\n', 'doc', 'v1');
    const next = await buildBlocks('# 시작\n\n나눈 부분 A\n\n나눈 부분 B\n\n# 끝\n', 'doc', 'v2', first);
    expect(next[0].id).toBe(first[0].id);
    expect(next.at(-1)!.id).toBe(first.at(-1)!.id);
    expect(next[1].predecessorIds).toEqual([first[1].id]);
    expect(next[2].predecessorIds).toEqual([first[1].id]);
    expect(next[1].id).not.toBe(first[1].id);
  });
});
