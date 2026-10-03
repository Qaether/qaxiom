import type { DocumentBlock } from './types';
import type { ReviewIssue } from './reviewTypes';

export interface TheoryDeclarations {
  symbols: { name: string; meaning: string; definedAt: string; scope: string[] }[];
  uses: { name: string; at: string }[];
  dependencies: { from: string; to: string; kind: 'proof' | 'concept' }[];
}
const normalized = (name: string) => name.normalize('NFKC').trim();
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

export function parseDeclarations(value: unknown): TheoryDeclarations {
  function fail(): never { throw new Error('선언은 symbols/uses/dependencies 배열, 원문 블록 ID와 proof/concept 종류를 가져야 합니다. 각 배열은 1,000개 이하여야 합니다.'); }
  if (!record(value) || !Array.isArray(value.symbols) || !Array.isArray(value.uses) || !Array.isArray(value.dependencies)
    || [value.symbols, value.uses, value.dependencies].some(items => items.length > 1000)) fail();
  const symbols = (value.symbols as unknown[]).map(item => {
    if (!record(item) || !text(item.name) || !text(item.meaning) || !text(item.definedAt) || !Array.isArray(item.scope)
      || item.scope.length > 1000 || !item.scope.every(text) || new Set(item.scope).size !== item.scope.length) fail();
    return { name: item.name, meaning: item.meaning, definedAt: item.definedAt, scope: item.scope as string[] };
  });
  const uses = (value.uses as unknown[]).map(item => {
    if (!record(item) || !text(item.name) || !text(item.at)) fail();
    return { name: item.name, at: item.at };
  });
  const dependencies = (value.dependencies as unknown[]).map(item => {
    if (!record(item) || !text(item.from) || !text(item.to) || !['proof', 'concept'].includes(String(item.kind))) fail();
    return { from: item.from, to: item.to, kind: item.kind as 'proof' | 'concept' };
  });
  return { symbols, uses, dependencies };
}

/** Declarations are canonical source blocks, never inferred semantic truth. */
export function checkDeclarations(blocks: DocumentBlock[]): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const ids = new Set(blocks.map(block => block.id));
  const declarations: { block: DocumentBlock; data: TheoryDeclarations }[] = [];
  const issue = (kind: ReviewIssue['kind'], sources: DocumentBlock[], explanation: string, resolution: string) => {
    const unique = [...new Map(sources.map(block => [block.id, block])).values()];
    issues.push({ id: crypto.randomUUID(), kind, severity: 'warning', blockIds: unique.map(block => block.id),
      quotes: unique.map(block => block.text), explanation, resolution, resolvedByRunId: null });
  };
  for (const block of blocks) {
    if (block.kind !== 'code') continue;
    const match = /^\s*(`{3,}|~{3,})qaxiom-declarations\s*\r?\n([\s\S]*)\r?\n\s*(`{3,}|~{3,})\s*$/.exec(block.text);
    if (!match) {
      if (/^\s*(?:`{3,}|~{3,})qaxiom-declarations\b/.test(block.text)) issue('invalid_declaration', [block], '선언 코드 블록의 끝 fence가 없거나 형식이 잘못되었습니다.', 'qaxiom-declarations 코드 블록을 올바르게 닫으세요.');
      continue;
    }
    try {
      if (match[1][0] !== match[3][0] || match[3].length < match[1].length || match[2].length > 100000) throw new Error('fence 또는 100,000자 제한 오류');
      declarations.push({ block, data: parseDeclarations(JSON.parse(match[2])) });
    } catch { issue('invalid_declaration', [block], '기호/의존성 선언 JSON 또는 필드 형식이 올바르지 않습니다.', 'symbols/uses/dependencies와 블록 ID, proof/concept 종류를 확인하세요.'); }
  }
  const symbols: { block: DocumentBlock; symbol: TheoryDeclarations['symbols'][number] }[] = [];
  const edges: { from: string; to: string; block: DocumentBlock }[] = [];
  if (['symbols', 'uses', 'dependencies'].some(key => declarations.reduce((sum, declaration) => sum + declaration.data[key as keyof TheoryDeclarations].length, 0) > 1000)) {
    issue('invalid_declaration', declarations.map(declaration => declaration.block), '문서 전체 선언이 항목별 1,000개 검사 한도를 넘습니다. 검사하지 못한 선언을 정상으로 간주하지 않습니다.', '선언/문서를 나눠 검토하세요.');
    return issues;
  }
  for (const { block, data } of declarations) {
    for (const symbol of data.symbols) {
      if (!ids.has(symbol.definedAt) || symbol.scope.some(id => !ids.has(id))) {
        issue('broken_reference', [block], `기호 ${symbol.name}의 정의/범위가 현재 버전에 없는 블록을 참조합니다.`, '현재 버전의 정의와 적용 범위 ID를 연결하세요.'); continue;
      }
      symbols.push({ block, symbol });
    }
    for (const dependency of data.dependencies) {
      if (!ids.has(dependency.from) || !ids.has(dependency.to)) issue('broken_reference', [block], '선언된 의존성이 현재 버전에 없는 블록을 참조합니다.', '양 끝 블록 ID를 현재 버전에 맞춰 수정하세요.');
      else if (dependency.kind === 'proof') edges.push({ ...dependency, block });
    }
  }
  const scopes = symbols.map(({ symbol }) => new Set(symbol.scope));
  const names = symbols.map(({ symbol }) => normalized(symbol.name));
  const available = new Map<string, { global: boolean; scope: Set<string> }>();
  symbols.forEach(({ symbol }, index) => {
    const entry = available.get(names[index]) ?? { global: false, scope: new Set<string>() };
    entry.global ||= symbol.scope.length === 0;
    for (const id of symbol.scope) entry.scope.add(id);
    available.set(names[index], entry);
  });
  let comparisons = 0;
  for (let i = 0; i < symbols.length; i++) for (let j = i + 1; j < symbols.length; j++) {
    const a = symbols[i], b = symbols[j];
    if (names[i] !== names[j]) continue;
    comparisons += Math.min(a.symbol.scope.length, b.symbol.scope.length) + 1;
    if (comparisons > 100000) {
      issue('invalid_declaration', declarations.map(declaration => declaration.block), '기호 범위 검사 작업 예산을 넘었습니다. 나머지 선언은 검사하지 못했습니다.', '기호/범위를 나눠 검토하세요.'); return issues;
    }
    const overlap = !a.symbol.scope.length || !b.symbol.scope.length || (scopes[i].size < scopes[j].size ? a.symbol.scope.some(id => scopes[j].has(id)) : b.symbol.scope.some(id => scopes[i].has(id)));
    if (normalized(a.symbol.name) === normalized(b.symbol.name) && overlap && a.symbol.meaning.trim() !== b.symbol.meaning.trim()) {
      issue('symbol_conflict', [a.block, b.block], `기호 ${a.symbol.name}의 겹치는 범위에서 의미 문자열이 다릅니다. 의미적 모순 판정이 아닌 선언 충돌 후보입니다.`, '기호 이름/범위/정의를 분리하거나 같은 정의임을 명시하세요.');
    }
  }
  for (const { block, data } of declarations) for (const use of data.uses) {
    const definition = available.get(normalized(use.name));
    if (!ids.has(use.at)) issue('broken_reference', [block], `기호 ${use.name}의 사용 위치가 현재 버전에 없습니다.`, '사용 위치의 블록 ID를 수정하세요.');
    else if (!definition || !definition.global && !definition.scope.has(use.at)) {
      issue('undefined_symbol', [block], `기호 ${use.name}의 선언된 사용 범위에 유효한 정의가 없습니다.`, '사용 블록을 포함하는 기호 정의를 선언하세요.');
    }
  }
  // Iterative DFS avoids a recursive call stack overflow on long proof chains.
  const graph = new Map<string, typeof edges>();
  for (const edge of edges) graph.set(edge.from, [...(graph.get(edge.from) ?? []), edge]);
  const state = new Map<string, number>(), reported = new Set<string>();
  for (const node of graph.keys()) {
    if (state.has(node)) continue;
    const stack = [{ node, cursor: 0 }]; state.set(node, 1);
    while (stack.length) {
      const frame = stack.at(-1)!;
      const edge = (graph.get(frame.node) ?? [])[frame.cursor++];
      if (!edge) { state.set(frame.node, 2); stack.pop(); continue; }
      if (!state.has(edge.to)) { state.set(edge.to, 1); stack.push({ node: edge.to, cursor: 0 }); }
      else if (state.get(edge.to) === 1) {
        const nodes = stack.slice(stack.findIndex(frame => frame.node === edge.to)).map(frame => frame.node);
        const key = [...nodes].sort().join(':');
        if (reported.has(key)) continue; reported.add(key);
        const sources = nodes.map((from, index) => graph.get(from)!.find(candidate => candidate.to === (nodes[index + 1] ?? edge.to))!.block);
        issue('proof_cycle', sources, `선언된 증명 의존성에 순환이 있습니다: ${[...nodes, edge.to].join(' → ')}. 일반 개념 연결의 순환은 검사하지 않습니다.`, '증명의 전제/결론 의존성을 분리하고 순환하지 않는 증명 구조를 선언하세요.');
      }
    }
  }
  return issues;
}

export function declarationTemplate(blocks: DocumentBlock[]) {
  const block = blocks.find(block => block.kind !== 'heading' && block.kind !== 'code') ?? blocks[0];
  const data: TheoryDeclarations = { symbols: block ? [{ name: 'x', meaning: '사용자가 정의할 변수 — 실제 의미로 수정하세요', definedAt: block.id, scope: [block.id] }] : [], uses: [], dependencies: [] };
  return '\n\n```qaxiom-declarations\n' + JSON.stringify(data, null, 2) + '\n```\n';
}
