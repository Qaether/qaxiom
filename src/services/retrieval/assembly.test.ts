// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { QaxiomDatabase } from '../database';
import { createTheory, saveTheoryVersion } from '../theory/documents';
import { EMPTY_CONTRACT } from '../theory/types';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { importReference, loadReferenceSelection } from './references';
import { assembleContext, parentCandidates } from './assembly';
import { searchBM25 } from './bm25';
import { parseContextBundle } from './validation';
import { withReferenceContext } from './context';

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`assembly-${crypto.randomUUID()}`); target = new QaxiomDatabase(`target-${crypto.randomUUID()}`); });
afterEach(async () => { await db.delete(); await target.delete(); });
async function fixture(text = '# 상위\r\n\r\n공통 설명\r\n\r\n## 조건\r\n\r\nx > 0\r\n\r\nneedle 결론\r\n\r\n## 다른 절\r\n\r\nUNRELATED_SECTION') {
  const source = (await importReference('scope.md', text, 'external', db)).source;
  const excluded = (await importReference('excluded.txt', 'needle EXCLUDED', 'external', db)).source;
  const data = await loadReferenceSelection([source.id], db);
  const hits = searchBM25(data, 'needle', 1);
  const theory = await createTheory({ title: '선택 연구', markdown: 'CANONICAL_BODY_NOT_SENT', contract: { ...EMPTY_CONTRACT, assumptions: 'MANDATORY_UNRANKED x > 0', scope: '실수' } }, db);
  return { source, excluded, data, hits, theory, bundle: assembleContext('needle', [source.id], hits, data, theory.version) };
}

it('adds ancestor headings and the nearest section, without adjacent sections or unselected sources', async () => {
  const { bundle } = await fixture();
  expect(bundle.evidence.map(item => item.span.text).join('')).toContain('x > 0');
  expect(bundle.evidence.map(item => item.span.text).join('')).toContain('# 상위');
  expect(bundle.evidence.map(item => item.span.text).join('')).not.toContain('UNRELATED_SECTION');
  expect(bundle.evidence.map(item => item.span.text).join('')).not.toContain('EXCLUDED');
  expect(bundle.assembly!.parentSpanIds.length).toBe(3);
  const payload = withReferenceContext([{ id: 'u', role: 'user', content: 'needle', timestamp: 0 }], bundle)[0].content;
  expect(payload).toContain('MANDATORY_UNRANKED');
  expect(payload).not.toContain('CANONICAL_BODY_NOT_SENT');
  expect(bundle.assembly!.research!.emptyFields).toContain('definitions');
});

it('records every excluded parent span and never silently truncates selected evidence or mandatory criteria', async () => {
  const { data, hits, source, theory } = await fixture('# 大\n\n' + Array.from({ length: 14 }, (_, i) => `paragraph-${i} ${'가'.repeat(1000)}${i === 10 ? ' needle' : ''}`).join('\n\n'));
  const bundle = assembleContext('needle', [source.id], hits, data, theory.version);
  const expected = parentCandidates(hits[0], data).map(hit => hit.span.id);
  expect(bundle.evidence.length).toBeLessThanOrEqual(8);
  expect(bundle.assembly!.omittedSpanIds.length).toBeGreaterThan(0);
  expect(bundle.assembly!.omissions.map(item => item.spanId)).toEqual(bundle.assembly!.omittedSpanIds);
  expect(bundle.assembly!.omissions.every(item => item.reason === 'context_budget' && item.startOffset < item.endOffset)).toBe(true);
  expect(new Set([...bundle.evidence.map(item => item.span.id), ...bundle.assembly!.omittedSpanIds])).toEqual(new Set(expected));
  const tooLarge = { ...theory.version, contract: { ...EMPTY_CONTRACT, assumptions: 'A'.repeat(12001) } };
  expect(() => assembleContext('needle', [source.id], hits, data, tooLarge)).toThrow('연구 기준은 자르지');
});

it('does not mistake fenced code headings for sections and deduplicates overlapping parents', async () => {
  const { source, hits, data } = await fixture('# 조건\n\n가정\n\n```\n# fake\nneedle\n```\n\nneedle 결론\n\n# 경계\n\nUNRELATED_SECTION');
  const two = searchBM25(data, 'needle');
  const bundle = assembleContext('needle', [source.id], two, data);
  expect(new Set(bundle.evidence.map(item => item.span.id)).size).toBe(bundle.evidence.length);
  expect(bundle.evidence.map(item => item.span.text).join('')).toContain('가정');
  expect(parentCandidates(hits[0], data).some(hit => hit.span.text.includes('UNRELATED_SECTION'))).toBe(false);
});

it('expands PDF context only on the same explicit page', async () => {
  const { hits, data } = await fixture();
  const pdfData = structuredClone(data);
  pdfData.references[0].pdf = { assetId: 'pdf', fileHash: 'hash', engineVersion: 'test', pageCount: 2, pages: [] };
  pdfData.referenceSpans.forEach((span, i) => { span.page = i < 4 ? 1 : 2; });
  const hit = { ...hits[0], source: pdfData.references[0], span: pdfData.referenceSpans[2] };
  expect(parentCandidates(hit, pdfData)).toHaveLength(4);
  expect(parentCandidates(hit, pdfData).every(candidate => candidate.span.page === 1)).toBe(true);
});

it('rejects stale source metadata and restores a source that became a canonical snapshot after ingestion', async () => {
  const { hits, data, source } = await fixture();
  expect(() => assembleContext('needle', [source.id], [{ ...hits[0], source: { ...source, name: 'changed.md' } }], data)).toThrow('다시 검색');
  const theory = await createTheory({ title: '후속 정본', markdown: source.text, contract: { ...EMPTY_CONTRACT } }, db);
  const derived = await loadReferenceSelection([source.id], db);
  const bundle = assembleContext('needle', [source.id], searchBM25(derived, 'needle', 1), derived, theory.version);
  await db.sessions.add({ id: 's', title: 's', position: 0, createdAt: 0, updatedAt: 0, selectedModel: 'gpt-6-astra', researchMode: 'general' });
  await db.messages.add({ id: 'a', sessionId: 's', position: 0, role: 'assistant', content: '[[R1]]', timestamp: 0, contextBundle: bundle });
  await restoreWorkspaceBundle(JSON.parse(JSON.stringify(await createWorkspaceBundle(db))), target);
  expect((await target.messages.toArray())[0].contextBundle).toEqual(bundle);
  expect(bundle.evidence.every(item => item.role === 'theory_snapshot')).toBe(true);
});

it('freezes selected research versions and verifies contracts, parents and omission manifests on restore', async () => {
  const { bundle, theory, data } = await fixture();
  await saveTheoryVersion(theory.document.id, theory.version.id, { title: '변경', markdown: 'new', contract: { ...EMPTY_CONTRACT, assumptions: 'NEW_CRITERIA' } }, db);
  expect(bundle.assembly!.research!.contract.assumptions).toContain('MANDATORY_UNRANKED');
  await db.sessions.add({ id: 's', title: 's', position: 0, createdAt: 0, updatedAt: 0, selectedModel: 'gpt-6-astra', researchMode: 'general' });
  await db.messages.add({ id: 'a', sessionId: 's', position: 0, role: 'assistant', content: '[[R1]]', timestamp: 0, contextBundle: bundle });
  const backup = await createWorkspaceBundle(db);
  expect(backup.markdown[0].content).toContain('MANDATORY_UNRANKED');
  await restoreWorkspaceBundle(JSON.parse(JSON.stringify(backup)), target);
  expect((await target.messages.toArray())[0].contextBundle).toEqual(bundle);
  for (const mutation of [
    (copy: typeof bundle) => { copy.assembly!.research!.contract.assumptions = 'tampered'; },
    (copy: typeof bundle) => { copy.assembly!.omittedSpanIds.push('invented'); },
    (copy: typeof bundle) => { copy.assembly!.parentSpanIds = []; },
    (copy: typeof bundle) => { copy.assembly!.omissions.push({ spanId: 'invented', sourceId: 'invented', name: 'x', startLine: 1, endLine: 2, startOffset: 0, endOffset: 3, reason: 'context_budget' }); },
    (copy: typeof bundle) => { copy.assembly!.research!.versionId = 'missing'; }
  ]) {
    const invalid = structuredClone(bundle); mutation(invalid);
    expect(() => parseContextBundle(invalid, data, [theory.version])).toThrow();
  }
  const invalidBackup = structuredClone(backup);
  invalidBackup.data.messages[0].contextBundle!.assembly!.research!.contract.scope = 'tampered';
  await expect(restoreWorkspaceBundle(invalidBackup, target)).rejects.toThrow();
  expect((await target.messages.toArray())[0].contextBundle).toEqual(bundle);
});
