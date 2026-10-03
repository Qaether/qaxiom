import type { DocumentBlock, TheorySnapshot } from './types';

export async function verifyCanonicalSnapshot(snapshot: TheorySnapshot) {
  const parts = splitMarkdown(snapshot.version.markdown);
  if (await hashText(snapshot.version.markdown) !== snapshot.version.contentHash || parts.length !== snapshot.blocks.length) throw new Error('정본 hash/블록 구조가 일치하지 않습니다.');
  for (const [i, b] of snapshot.blocks.entries()) if (b.versionId !== snapshot.version.id || b.documentId !== snapshot.document.id || b.position !== i
    || b.startOffset !== parts[i].startOffset || b.endOffset !== parts[i].endOffset || b.text !== parts[i].text || b.kind !== parts[i].kind
    || await hashText(b.text) !== b.contentHash) throw new Error('정본 블록 원문/위치/hash가 일치하지 않습니다.');
  for (const [field, anchor] of Object.entries(snapshot.version.contractAnchors ?? {})) {
    if (!(field in snapshot.version.contract) || !snapshot.version.contract[field as keyof typeof snapshot.version.contract].trim()
      || !snapshot.blocks.some(block => block.id === anchor.blockId && block.contentHash === anchor.blockHash))
      throw new Error('연구 기준 원문 블록 연결이 현재 정본과 일치하지 않습니다.');
  }
}

export async function hashText(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Preserve offsets into the original Markdown, including CRLF and fenced blocks.
export function splitMarkdown(markdown: string) {
  const parts: { startOffset: number; endOffset: number; text: string; kind: DocumentBlock['kind'] }[] = [];
  let start = 0;
  let fence: string | null = null;
  let kind: DocumentBlock['kind'] = 'paragraph';
  const push = (end: number) => {
    const text = markdown.slice(start, end);
    if (text.trim()) parts.push({ startOffset: start, endOffset: end, text, kind });
    start = end;
    kind = 'paragraph';
  };
  for (const match of markdown.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const line = match[0].trim();
    const end = match.index + match[0].length;
    if (fence) {
      const closes = fence === '$$' ? line === '$$'
        : new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(line);
      if (closes) { fence = null; push(end); }
      continue;
    }
    const opening = /^(?:`{3,}|~{3,})/.exec(line)?.[0];
    if (opening || line === '$$') {
      push(match.index);
      fence = opening || '$$';
      kind = opening ? 'code' : 'math';
    } else if (/^#{1,6}\s/.test(line)) {
      push(match.index);
      kind = 'heading';
      push(end);
    } else if (!line) {
      push(end);
    }
  }
  push(markdown.length);
  return parts;
}

export async function buildBlocks(
  markdown: string, documentId: string, versionId: string, previous: DocumentBlock[] = []
): Promise<DocumentBlock[]> {
  const parts = splitMarkdown(markdown);
  const hashes = await Promise.all(parts.map(part => hashText(part.text)));
  const used = new Set<string>();
  const matches = hashes.map(hash => {
    const found = previous.find(block => block.contentHash === hash && !used.has(block.id));
    if (found) used.add(found.id);
    return found;
  });
  // Appending an annotation block may only add terminal line breaks to the
  // previous last paragraph. Preserve its logical ID if correspondence is unique.
  const withoutTerminalNewlines = (text: string) => text.replace(/(?:\r?\n)+$/, '');
  const normalizedKey = (block: { kind: DocumentBlock['kind']; text: string }) => `${block.kind}\u0000${withoutTerminalNewlines(block.text)}`;
  const partCounts = new Map<string, number>();
  for (const part of parts) partCounts.set(normalizedKey(part), (partCounts.get(normalizedKey(part)) ?? 0) + 1);
  const normalizedPrevious = new Map<string, DocumentBlock[]>();
  for (const block of previous) if (!used.has(block.id)) {
    const key = normalizedKey(block); normalizedPrevious.set(key, [...(normalizedPrevious.get(key) ?? []), block]);
  }
  parts.forEach((part, position) => {
    if (matches[position]) return;
    const key = normalizedKey(part);
    if (partCounts.get(key) !== 1) return;
    const candidates = normalizedPrevious.get(key) ?? [];
    if (candidates.length === 1) { matches[position] = candidates[0]; used.add(candidates[0].id); }
  });
  return parts.map((part, position) => {
    const exact = matches[position];
    // Only carry an edited ID across an unambiguous one-to-one anchored gap.
    let left = position - 1;
    let right = position + 1;
    while (left >= 0 && !matches[left]) left--;
    while (right < parts.length && !matches[right]) right++;
    const oldLeft = left >= 0 ? previous.findIndex(b => b.id === matches[left]!.id) : -1;
    const oldRight = right < parts.length ? previous.findIndex(b => b.id === matches[right]!.id) : previous.length;
    const candidates = oldRight > oldLeft
      ? previous.slice(oldLeft + 1, oldRight).filter(b => !used.has(b.id)) : [];
    const edited = !exact && right - left === 2 && candidates.length === 1 ? candidates[0] : undefined;
    return {
      ...part, id: exact?.id || edited?.id || crypto.randomUUID(),
      documentId, versionId, position, contentHash: hashes[position],
      predecessorIds: exact ? [exact.id] : candidates.map(block => block.id)
    };
  });
}

export function compareBlocks(before: DocumentBlock[], after: DocumentBlock[]) {
  const old = new Map(before.map(block => [block.id, block]));
  const current = new Map(after.map(block => [block.id, block]));
  return [
    ...after.map(block => ({
      id: block.id, before: old.get(block.id)?.text || '', after: block.text,
      change: !old.has(block.id) ? 'added'
        : old.get(block.id)!.contentHash !== block.contentHash ? 'changed'
        : old.get(block.id)!.position !== block.position ? 'moved' : 'unchanged'
    })),
    ...before.filter(block => !current.has(block.id))
      .map(block => ({ id: block.id, before: block.text, after: '', change: 'removed' }))
  ];
}
