import { anchorKey, type ResearchRelation } from './relationTypes';

// Only explicitly approved, currently active dependencies participate. Concept cycles are legal.
export function relationGraph(relations: ResearchRelation[], focusKey: string) {
  const outgoing = relations.filter(r => anchorKey(r.from) === focusKey);
  const incoming = relations.filter(r => anchorKey(r.to) === focusKey);
  const dependencies = new Map<string, string[]>(), dependents = new Map<string, string[]>(), proof = new Map<string, string[]>();
  for (const r of relations) if (r.kind === 'depends_on' && r.to.type === 'claim') {
    const from = anchorKey(r.from), to = anchorKey(r.to);
    dependencies.set(from, [...dependencies.get(from) ?? [], to]);
    dependents.set(to, [...dependents.get(to) ?? [], from]);
    if (r.dependencyType === 'proof') proof.set(from, [...proof.get(from) ?? [], to]);
  }
  const traverse = (edges: Map<string, string[]>) => {
    const visited = new Set<string>([focusKey]), queue = [...edges.get(focusKey) ?? []];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]; if (visited.has(id)) continue;
      visited.add(id); queue.push(...edges.get(id) ?? []);
    }
    visited.delete(focusKey); return [...visited];
  };
  const state = new Map<string, number>(), cycleEdges = new Set<string>();
  for (const root of proof.keys()) {
    if (state.has(root)) continue;
    const stack = [{ id: root, index: 0 }]; state.set(root, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1], next = proof.get(frame.id) ?? [];
      if (frame.index >= next.length) { state.set(frame.id, 2); stack.pop(); continue; }
      const id = next[frame.index++];
      if (state.get(id) === 1) {
        const start = stack.findIndex(f => f.id === id);
        const path = stack.slice(start).map(f => f.id); path.push(id);
        for (let i = 0; i < path.length - 1; i++) cycleEdges.add(JSON.stringify([path[i], path[i + 1]]));
      } else if (!state.has(id)) { state.set(id, 1); stack.push({ id, index: 0 }); }
    }
  }
  const proofCycleRelationIds = relations.filter(r => r.kind === 'depends_on' && r.dependencyType === 'proof'
    && cycleEdges.has(JSON.stringify([anchorKey(r.from), anchorKey(r.to)]))).map(r => r.id);
  return { outgoing, incoming, dependencies: traverse(dependencies), impacted: traverse(dependents), proofCycleRelationIds };
}
