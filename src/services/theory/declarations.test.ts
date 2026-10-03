// @vitest-environment jsdom
import { it, expect, beforeEach, afterEach } from 'vitest';
import { QaxiomDatabase } from '../database';
import { createTheory, saveTheoryVersion } from './documents';
import { EMPTY_CONTRACT } from './types';
import { checkDeclarations, parseDeclarations, declarationTemplate, type TheoryDeclarations } from './declarations';
import { runLocalReview } from './reviews';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { checkerCovers } from './reviewTypes';

let db: QaxiomDatabase, target: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`declarations-${crypto.randomUUID()}`); target = new QaxiomDatabase(`decl-target-${crypto.randomUUID()}`); });
afterEach(async () => { await db.delete(); await target.delete(); });
async function fixture(data: (first: string, second: string) => TheoryDeclarations) {
  const snapshot = await createTheory({ title: '명시적 선언', markdown: '# 정의\n\nx는 변수다.\n\n# 정리\n\ny는 결과다.\n', contract: { ...EMPTY_CONTRACT } }, db);
  const first = snapshot.blocks[1].id, second = snapshot.blocks[3].id;
  const markdown = snapshot.version.markdown + '\n\n```qaxiom-declarations\n' + JSON.stringify(data(first, second)) + '\n```\n';
  const saved = await saveTheoryVersion(snapshot.document.id, snapshot.version.id, { title: snapshot.version.title, markdown, contract: snapshot.version.contract }, db);
  expect(saved.blocks.some(block => block.id === first)).toBe(true);
  expect(saved.blocks.some(block => block.id === second)).toBe(true);
  return { saved, first, second };
}
const empty = (): TheoryDeclarations => ({ symbols: [], uses: [], dependencies: [] });

it('checks scope collisions and out-of-scope uses, preserving exact declaration provenance', async () => {
  const { saved } = await fixture((first, second) => ({
    symbols: [{ name: 'x', meaning: '위치', definedAt: first, scope: [first] }, { name: '𝑥', meaning: '확률', definedAt: second, scope: [first] }],
    uses: [{ name: 'x', at: second }], dependencies: []
  }));
  const issues = checkDeclarations(saved.blocks);
  expect(issues.map(issue => issue.kind)).toEqual(['symbol_conflict', 'undefined_symbol']);
  expect(issues.every(issue => saved.blocks.find(block => block.id === issue.blockIds[0])?.text === issue.quotes[0])).toBe(true);
  const run = await runLocalReview(saved, db); expect(run.checker).toBe('local-v2');
  const backup = await createWorkspaceBundle(db);
  await restoreWorkspaceBundle(JSON.parse(JSON.stringify(backup)), target);
  expect((await target.review_runs.get(run.id))!.issues.map(issue => issue.kind)).toContain('symbol_conflict');
});

it('allows disjoint scopes and equal meanings, with an empty scope meaning the full document', async () => {
  const { saved } = await fixture((first, second) => ({ symbols: [
    { name: 'x', meaning: '位置', definedAt: first, scope: [first] }, { name: 'x', meaning: '확률', definedAt: second, scope: [second] },
    { name: 'y', meaning: '결과', definedAt: second, scope: [] }, { name: 'y', meaning: '결과', definedAt: second, scope: [second] }
  ], uses: [{ name: 'y', at: first }], dependencies: [] }));
  expect(checkDeclarations(saved.blocks)).toEqual([]);
});

it('detects explicit proof cycles while allowing concept cycles, self links and DAGs', async () => {
  const { saved, first, second } = await fixture((first, second) => ({ ...empty(), dependencies: [
    { from: first, to: second, kind: 'proof' }, { from: second, to: first, kind: 'proof' },
    { from: first, to: first, kind: 'concept' }
  ] }));
  expect(checkDeclarations(saved.blocks).filter(issue => issue.kind === 'proof_cycle')).toHaveLength(1);
  const code = saved.blocks.at(-1)!;
  const conceptual = JSON.stringify({ ...empty(), dependencies: [{ from: first, to: second, kind: 'concept' }, { from: second, to: first, kind: 'concept' }] });
  expect(checkDeclarations(saved.blocks.map(block => block.id === code.id ? { ...block, text: '```qaxiom-declarations\n' + conceptual + '\n```\n' } : block))).toEqual([]);
});

it('reports missing nodes, invalid declaration JSON, an unclosed fence and bounded work without a false pass', async () => {
  const { saved } = await fixture(first => ({ symbols: [{ name: 'x', meaning: '변수', definedAt: 'missing', scope: [] }], uses: [{ name: 'y', at: first }], dependencies: [{ from: first, to: 'missing', kind: 'proof' }] }));
  expect(checkDeclarations(saved.blocks).map(issue => issue.kind)).toEqual(['broken_reference', 'broken_reference', 'undefined_symbol']);
  for (const raw of ['```qaxiom-declarations\n{broken}\n```\n', '```qaxiom-declarations\n{}', '```qaxiom-declarations\n{"symbols":[]}\n```']) {
    expect(checkDeclarations([{ ...saved.blocks[0], kind: 'code', text: raw }])[0].kind).toBe('invalid_declaration');
  }
  expect(() => parseDeclarations({ ...empty(), dependencies: Array(1001).fill({ from: 'a', to: 'b', kind: 'proof' }) })).toThrow('1,000');
  expect(() => parseDeclarations({ ...empty(), dependencies: [{ from: 'a', to: 'b', kind: 'exec' }] })).toThrow();
});

it('preserves a sole paragraph ID when appending a declaration template and supports the v1 local check subset', async () => {
  const snapshot = await createTheory({ title: '단일 문단', markdown: 'x 정의', contract: { ...EMPTY_CONTRACT } }, db);
  const saved = await saveTheoryVersion(snapshot.document.id, snapshot.version.id, { title: snapshot.version.title,
    markdown: snapshot.version.markdown + declarationTemplate(snapshot.blocks), contract: snapshot.version.contract }, db);
  expect(saved.blocks[0].id).toBe(snapshot.blocks[0].id);
  expect(checkDeclarations(saved.blocks)).toEqual([]);
  expect(checkerCovers('local-v1', 'local-v2')).toBe(true);
  expect(checkerCovers('local-v2', 'local-v1')).toBe(false);
  expect(checkerCovers('llm-v1', 'local-v2')).toBe(false);
});
