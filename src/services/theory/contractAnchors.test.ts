// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import Dexie from 'dexie';
import { QaxiomDatabase } from '../database';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { assembleContext } from '../retrieval/assembly';
import { importReference } from '../retrieval/references';
import { parseContextBundle } from '../retrieval/validation';
import { createTheory, saveTheoryVersion } from './documents';
import { EMPTY_CONTRACT } from './types';

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`anchors-${crypto.randomUUID()}`); target = new QaxiomDatabase(`anchors-target-${crypto.randomUUID()}`); });
afterEach(async () => { await db.delete(); await target.delete(); });

async function fixture() {
  const snapshot = await createTheory({ title: '기준 원문', markdown: '# 가정\n\nx > 0.\n\n# 결론\n\ny > x.',
    contract: { ...EMPTY_CONTRACT, assumptions: 'x > 0' } }, db);
  const block = snapshot.blocks.find(item => item.text.includes('x > 0.'))!;
  return { snapshot, block };
}

it('stores explicit field-to-version block anchors and exposes metadata without sending the block text', async () => {
  const { snapshot, block } = await fixture();
  const saved = await saveTheoryVersion(snapshot.document.id, snapshot.version.id, { title: snapshot.version.title,
    markdown: snapshot.version.markdown, contract: snapshot.version.contract,
    contractAnchors: { assumptions: { blockId: block.id, blockHash: block.contentHash } } }, db);
  expect(saved.version.number).toBe(2);
  expect(saved.version.contractAnchors.assumptions).toEqual({ blockId: block.id, blockHash: block.contentHash });
  const source = (await importReference('independent.md', 'External evidence.', 'external', db)).source;
  const span = (await db.reference_spans.where('sourceId').equals(source.id).first())!;
  const bundle = assembleContext('질문', [source.id], [{ source, span, score: 1 }],
    { references: [source], referenceSpans: [span] }, saved.version);
  expect(bundle.assembly?.research?.contractAnchors?.assumptions?.blockId).toBe(block.id);
  expect(JSON.stringify(bundle.assembly?.research)).not.toContain('x > 0.');
  const invalid = structuredClone(bundle);
  invalid.assembly!.research!.contractAnchors!.assumptions!.blockHash = '0'.repeat(64);
  expect(() => parseContextBundle(invalid, { references: [source], referenceSpans: [span] }, [saved.version])).toThrow();
  const next = await saveTheoryVersion(saved.document.id, saved.version.id, { title: saved.version.title,
    markdown: `${saved.version.markdown}\n\n새 문단.`, contract: saved.version.contract }, db);
  expect(next.version.contractAnchors.assumptions).toEqual(saved.version.contractAnchors.assumptions);
  const changed = await saveTheoryVersion(next.document.id, next.version.id, { title: next.version.title,
    markdown: next.version.markdown.replace('x > 0.', 'x > 1.'), contract: next.version.contract }, db);
  expect(changed.version.contractAnchors).toEqual({});
});

it('rejects stale or fabricated anchors and validates v22 backups atomically', async () => {
  const { snapshot, block } = await fixture();
  await expect(saveTheoryVersion(snapshot.document.id, snapshot.version.id, { title: snapshot.version.title,
    markdown: snapshot.version.markdown.replace('x > 0.', 'x > 1.'), contract: snapshot.version.contract,
    contractAnchors: { assumptions: { blockId: block.id, blockHash: block.contentHash } } }, db)).rejects.toThrow('본문');
  const saved = await saveTheoryVersion(snapshot.document.id, snapshot.version.id, { title: snapshot.version.title,
    markdown: snapshot.version.markdown, contract: snapshot.version.contract,
    contractAnchors: { assumptions: { blockId: block.id, blockHash: block.contentHash } } }, db);
  const bundle = await createWorkspaceBundle(db); expect(bundle.version).toBe(22);
  await restoreWorkspaceBundle(bundle, target);
  expect((await target.document_versions.get(saved.version.id))?.contractAnchors).toEqual(saved.version.contractAnchors);
  const bad = structuredClone(bundle); bad.data.documentVersions.find(version => version.id === saved.version.id)!.contractAnchors.assumptions!.blockHash = '0'.repeat(64);
  await expect(restoreWorkspaceBundle(bad, target)).rejects.toThrow();
  expect((await target.document_versions.get(saved.version.id))?.contractAnchors).toEqual(saved.version.contractAnchors);
});

it('imports v21 backups and upgrades populated v21 stores without inventing anchors', async () => {
  const { snapshot } = await fixture(), bundle = await createWorkspaceBundle(db);
  const legacyBundle: { version: number; data: typeof bundle.data } = structuredClone(bundle);
  legacyBundle.version = 21;
  for (const version of legacyBundle.data.documentVersions) delete (version as Partial<typeof version>).contractAnchors;
  await restoreWorkspaceBundle(legacyBundle, target);
  expect((await target.document_versions.get(snapshot.version.id))?.contractAnchors).toEqual({});
  await target.delete();
  const legacy = new Dexie(target.name);
  legacy.version(21).stores(Object.fromEntries(db.tables.filter(table => table.name !== 'document_versions').map(table => [table.name,
    [table.schema.primKey.src, ...table.schema.indexes.map(index => index.src)].join(',')]).concat([['document_versions', '&id, documentId, &[documentId+number], contentHash']])));
  for (const table of db.tables) {
    const rows = await table.toArray();
    await legacy.table(table.name).bulkAdd(table.name === 'document_versions' ? rows.map(row => { const copy = { ...row }; delete copy.contractAnchors; return copy; }) : rows);
  }
  legacy.close(); await target.open();
  expect(target.verno).toBe(23);
  expect((await target.document_versions.get(snapshot.version.id))?.contractAnchors).toEqual({});
});
