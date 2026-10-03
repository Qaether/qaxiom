// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QaxiomDatabase, type MessageRecord } from '../database';
import { hashText } from '../theory/blocks';
import { deleteUnlinkedPdfAsset, deleteUnusedReference } from './referenceDeletion';
import { importReference } from './references';
import { hashBytes } from './pdfTypes';

let db: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`reference-delete-${crypto.randomUUID()}`); });
afterEach(async () => { await db.delete(); });

describe('unused reference deletion', () => {
  it('atomically removes an unused text source and its spans', async () => {
    const { source } = await importReference('unused.md', '# 자료\n\n삭제 가능한 원문', 'external', db);
    const count = await db.reference_spans.where('sourceId').equals(source.id).count();
    expect(count).toBeGreaterThan(0);
    await expect(deleteUnusedReference(source.id, '0'.repeat(64), db)).rejects.toThrow('변경');
    expect(await db.references.get(source.id)).toBeTruthy();

    const result = await deleteUnusedReference(source.id, source.contentHash, db);
    expect(result.removedSpanCount).toBe(count);
    expect(result.removedPdfAsset).toBe(false);
    expect(await db.references.get(source.id)).toBeUndefined();
    expect(await db.reference_spans.where('sourceId').equals(source.id).count()).toBe(0);
  });

  it('refuses a source pinned in an answer or project policy and preserves its spans', async () => {
    const { source } = await importReference('used.md', '# 자료\n\n인용된 원문', 'external', db);
    const spans = await db.reference_spans.where('sourceId').equals(source.id).toArray();
    await db.messages.add({
      sessionId: 'session-1', id: 'message-1', position: 0, role: 'assistant', timestamp: 1, content: '답변',
      contextBundle: { selectedSourceIds: [source.id] } as MessageRecord['contextBundle']
    });
    await expect(deleteUnusedReference(source.id, source.contentHash, db)).rejects.toThrow('사용 중');
    await db.messages.clear();
    await db.projects.add({ id: 'project-1', title: '프로젝트', canonicalDocumentId: 'document-1', createdAt: 1,
      sourcePolicy: { scope: 'research', revision: 1, allowedSourceIds: [source.id] } });
    await expect(deleteUnusedReference(source.id, source.contentHash, db)).rejects.toThrow('사용 중');
    expect(await db.references.get(source.id)).toBeTruthy();
    expect(await db.reference_spans.where('sourceId').equals(source.id).count()).toBe(spans.length);
  });

  it('rolls back span removal if deleting the source fails', async () => {
    const { source } = await importReference('rollback.txt', '자료 본문', 'external', db);
    const fail = () => { throw new Error('source delete failed'); };
    db.references.hook('deleting', fail);
    await expect(deleteUnusedReference(source.id, source.contentHash, db)).rejects.toThrow('source delete failed');
    db.references.hook('deleting').unsubscribe(fail);
    expect(await db.references.get(source.id)).toBeTruthy();
    expect(await db.reference_spans.where('sourceId').equals(source.id).count()).toBeGreaterThan(0);
  });

  it('also removes an unused PDF original but never a running original', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const fileHash = await hashBytes(bytes);
    const text = 'PDF 텍스트';
    const contentHash = await hashText(text);
    await db.pdf_assets.add({ id: 'asset-1', name: 'paper.pdf', fileHash, bytes, role: 'external', createdAt: 1,
      status: 'running', runId: 'run-1', pageCount: 1, pages: [{ number: 1, text }], engineVersion: 'test', error: '' });
    await db.references.add({ id: 'pdf-asset-1', name: 'paper.pdf', text, contentHash, role: 'external', originVersionId: null,
      createdAt: 1, parserVersion: 'pdfjs-v1', pdf: { assetId: 'asset-1', fileHash, pageCount: 1, engineVersion: 'test',
        pages: [{ number: 1, startOffset: 0, endOffset: text.length, status: 'text' }] } });
    await db.reference_spans.add({ id: 'span-1', sourceId: 'pdf-asset-1', position: 0, startOffset: 0,
      endOffset: text.length, startLine: 1, endLine: 1, page: 1, text, contentHash });
    await expect(deleteUnusedReference('pdf-asset-1', contentHash, db)).rejects.toThrow('PDF 원본 상태');
    expect(await db.pdf_assets.get('asset-1')).toBeTruthy();
    await db.pdf_assets.update('asset-1', { status: 'ready', runId: null });
    const result = await deleteUnusedReference('pdf-asset-1', contentHash, db);
    expect(result.removedPdfAsset).toBe(true);
    expect(await db.pdf_assets.get('asset-1')).toBeUndefined();
    expect(await db.reference_spans.count()).toBe(0);
  });
});

describe('unlinked PDF original deletion', () => {
  it('removes a textless PDF original without creating or altering searchable references', async () => {
    const bytes = new TextEncoder().encode('%PDF-textless-fixture').buffer;
    const fileHash = await hashBytes(bytes);
    await db.pdf_assets.add({ id: 'empty-asset', name: 'scan.pdf', fileHash, bytes, role: 'external', createdAt: 1,
      status: 'ocr_required', runId: null, pageCount: 1, pages: [{ number: 1, text: '' }], engineVersion: 'test', error: '' });
    expect(Object.prototype.toString.call((await db.pdf_assets.get('empty-asset'))?.bytes)).toBe('[object ArrayBuffer]');
    await expect(deleteUnlinkedPdfAsset('empty-asset', '0'.repeat(64), db)).rejects.toThrow('변경');
    expect(await db.pdf_assets.get('empty-asset')).toBeTruthy();
    await expect(deleteUnlinkedPdfAsset('empty-asset', fileHash, db)).resolves.toEqual({ name: 'scan.pdf' });
    expect(await db.pdf_assets.get('empty-asset')).toBeUndefined();
    expect(await db.references.count()).toBe(0);
  });

  it('refuses linked, processing or historically referenced PDF originals', async () => {
    const bytes = new TextEncoder().encode('%PDF-protected-fixture').buffer;
    const fileHash = await hashBytes(bytes);
    await db.pdf_assets.add({ id: 'protected-asset', name: 'protected.pdf', fileHash, bytes, role: 'external', createdAt: 1,
      status: 'running', runId: 'worker-1', pageCount: 0, pages: [], engineVersion: '', error: '' });
    await expect(deleteUnlinkedPdfAsset('protected-asset', fileHash, db)).rejects.toThrow('처리 중');
    await db.pdf_assets.put({ ...(await db.pdf_assets.get('protected-asset'))!, bytes, status: 'failed', runId: null });
    await db.references.add({ id: 'pdf-protected-asset', name: 'protected.pdf', text: '본문', contentHash: await hashText('본문'),
      role: 'external', originVersionId: null, createdAt: 1, parserVersion: 'pdfjs-v1',
      pdf: { assetId: 'protected-asset', fileHash, pageCount: 1, engineVersion: 'test', pages: [] } });
    await expect(deleteUnlinkedPdfAsset('protected-asset', fileHash, db)).rejects.toThrow('연결된 PDF');
    await db.references.clear();
    await db.projects.add({ id: 'project-1', title: '프로젝트', canonicalDocumentId: 'document-1', createdAt: 1,
      sourcePolicy: { scope: 'research', revision: 1, allowedSourceIds: ['pdf-protected-asset'] } });
    await expect(deleteUnlinkedPdfAsset('protected-asset', fileHash, db)).rejects.toThrow('사용 중');
    expect(await db.pdf_assets.get('protected-asset')).toBeTruthy();
  });

  it('keeps the original when deletion fails in the transaction', async () => {
    const bytes = new TextEncoder().encode('%PDF-rollback-fixture').buffer;
    const fileHash = await hashBytes(bytes);
    await db.pdf_assets.add({ id: 'rollback-asset', name: 'rollback.pdf', fileHash, bytes, role: 'note', createdAt: 1,
      status: 'failed', runId: null, pageCount: 0, pages: [], engineVersion: '', error: '' });
    const fail = () => { throw new Error('asset delete failed'); };
    db.pdf_assets.hook('deleting', fail);
    await expect(deleteUnlinkedPdfAsset('rollback-asset', fileHash, db)).rejects.toThrow('asset delete failed');
    db.pdf_assets.hook('deleting').unsubscribe(fail);
    expect(await db.pdf_assets.get('rollback-asset')).toBeTruthy();
  });
});
