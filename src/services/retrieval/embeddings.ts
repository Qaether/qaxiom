import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { hashText } from '../theory/blocks';
import { loadReferenceSelection } from './references';
import { normalizeVector, validSpace, type EmbeddingSpace, type EmbeddingVector } from './embeddingTypes';
import type { ReferenceData, ReferenceSpan } from './types';
import { assertEmbeddingScopeCurrent, assertEmbeddingScopeInTransaction, captureEmbeddingScope, type EmbeddingProjectScope } from './embeddingScope';

export const EMBEDDING_ENDPOINT = 'https://api.openai.com/v1/embeddings';
export const embeddingVectorHash = (vector: Omit<EmbeddingVector, 'vectorHash'>) => hashText(JSON.stringify({ spaceId: vector.spaceId, sourceId: vector.sourceId,
  sourceHash: vector.sourceHash, spanId: vector.spanId, spanHash: vector.spanHash, values: vector.values }));
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export function embeddingBody(space: EmbeddingSpace, input: string[]) {
  if (!validSpace(space) || !input.length || input.length > 16 || input.some(text => !text.trim() || new TextEncoder().encode(text).byteLength > 7500)) throw new Error('임베딩 입력은 빈 문자열 없이 16구간·구간당 UTF-8 7,500 bytes 이내여야 합니다.');
  const body = { model: space.model, dimensions: space.dimensions, encoding_format: 'float', input };
  if (bytes(body) > 48000) throw new Error('임베딩 요청이 UTF-8 48 KB를 넘습니다.'); return body;
}

export async function requestEmbeddings(space: EmbeddingSpace, input: string[], key: string, signal: AbortSignal) {
  const body = embeddingBody(space, input);
  if (!key.trim()) throw new Error('설정에 OpenAI API 키를 등록하세요.');
  signal.throwIfAborted();
  const response = await fetch(EMBEDDING_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.trim()}` }, body: JSON.stringify(body), signal });
  // Do not propagate provider bodies: they can echo submitted text or credentials.
  if (!response.ok) throw new Error(`OpenAI 임베딩 요청 실패 (HTTP ${response.status}). 자동 재시도하지 않습니다.`);
  const raw = await response.text(); signal.throwIfAborted();
  if (raw.length > 500000) throw new Error('임베딩 응답 크기 한도를 넘었습니다.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('임베딩 응답 JSON 형식 오류'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('임베딩 응답 형식 오류');
  const result = parsed as { model?: unknown; data?: unknown; usage?: { prompt_tokens?: unknown } };
  if (result.model !== space.model || !Array.isArray(result.data) || result.data.length !== input.length) throw new Error('임베딩 모델/응답 개수가 요청과 다릅니다.');
  const indices = new Set<number>(); const vectors: number[][] = [];
  for (const row of result.data) {
    if (!row || !Number.isSafeInteger(row.index) || row.index < 0 || row.index >= input.length || indices.has(row.index)) throw new Error('임베딩 응답 index가 없거나 중복되었습니다.');
    indices.add(row.index); vectors[row.index] = normalizeVector(row.embedding, space.dimensions);
  }
  const tokens = result.usage?.prompt_tokens;
  return { vectors, promptTokens: typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null };
}

export async function createEmbeddingSpace(db: QaxiomDatabase = qaxiomDatabase): Promise<EmbeddingSpace> {
  const space: EmbeddingSpace = { id: crypto.randomUUID(), provider: 'openai', model: 'text-embedding-3-small', dimensions: 512,
    adapterVersion: 'openai-embedding-v1', providerRevision: null, createdAt: Date.now(), runId: null, deadlineAt: null };
  await db.embedding_spaces.add(space); return space;
}
export interface EmbeddingPlan { space: EmbeddingSpace; data: ReferenceData; batches: ReferenceSpan[][]; cached: number; omitted: ReferenceSpan[]; maxRequests: number; projectScope?: EmbeddingProjectScope | null }
export async function prepareEmbeddingPlan(spaceId: string, sourceIds: string[], maxRequests: number, db: QaxiomDatabase = qaxiomDatabase, researchVersionId = '', projectId = ''): Promise<EmbeddingPlan> {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 100) throw new Error('색인 요청 예산은 1–100회여야 합니다.');
  const projectScope = await captureEmbeddingScope(researchVersionId, sourceIds, db, projectId);
  const space = await db.embedding_spaces.get(spaceId);
  if (!space || !validSpace(space)) throw new Error('색인 세대가 없습니다.');
  const data = await loadReferenceSelection(sourceIds, db), cached = await loadEmbeddingVectors(space, data, db);
  const existing = new Set(cached.map(v => v.spanId)); const missing = data.referenceSpans.filter(span => !existing.has(span.id));
  const batches: ReferenceSpan[][] = []; let batch: ReferenceSpan[] = [], index = 0;
  for (; index < missing.length; index++) {
    const span = missing[index];
    if (await hashText(span.text) !== span.contentHash) throw new Error('원문 구간 해시가 바뀌었습니다.');
    embeddingBody(space, [span.text]);
    try { embeddingBody(space, [...batch, span].map(s => s.text)); batch.push(span); }
    catch { batches.push(batch); batch = []; if (batches.length >= maxRequests) break; batch.push(span); }
  }
  if (batch.length) batches.push(batch);
  await assertEmbeddingScopeCurrent(projectScope, sourceIds, db);
  return { space, data, batches, cached: cached.length, omitted: missing.slice(index), maxRequests, projectScope };
}
export async function loadEmbeddingVectors(space: EmbeddingSpace, data: ReferenceData, db: QaxiomDatabase = qaxiomDatabase) {
  if (!validSpace(space)) throw new Error('색인 모델/차원 계약이 올바르지 않습니다.');
  const spans = new Map(data.referenceSpans.map(s => [s.id, s])); const sources = new Map(data.references.map(s => [s.id, s]));
  return (await db.embedding_vectors.where('spaceId').equals(space.id).toArray()).filter(v => {
    const span = spans.get(v.spanId), source = sources.get(v.sourceId);
    return span && source && v.sourceHash === source.contentHash && v.spanHash === span.contentHash && span.sourceId === source.id;
  });
}
async function verifyPlan(plan: EmbeddingPlan, db: QaxiomDatabase) {
  const chosen = new Map(plan.data.referenceSpans.map(s => [s.id, s]));
  const pending = plan.batches.flat();
  if (new Set(pending.map(s => s.id)).size !== pending.length || pending.some(s => {
    const span = chosen.get(s.id); return !span || span.text !== s.text || span.contentHash !== s.contentHash || span.sourceId !== s.sourceId;
  })) throw new Error('색인 입력이 선택한 미리보기 구간과 다릅니다.');
  const actual = await loadReferenceSelection(plan.data.references.map(s => s.id), db);
  if (actual.references.some(source => !plan.data.references.some(s => s.id === source.id && s.contentHash === source.contentHash))
    || actual.referenceSpans.length !== plan.data.referenceSpans.length
    || plan.data.referenceSpans.some(span => !actual.referenceSpans.some(s => s.id === span.id && s.contentHash === span.contentHash && s.text === span.text))) throw new Error('미리보기 원문/선택 범위가 바뀌었습니다. 다시 확인하세요.');
}
export async function indexEmbeddingPlan(plan: EmbeddingPlan, key: string, signal: AbortSignal, onProgress: (count: number, tokens: number | null) => void, db: QaxiomDatabase = qaxiomDatabase) {
  if (!key.trim()) throw new Error('설정에 OpenAI API 키를 등록하세요.');
  if (plan.batches.length > plan.maxRequests || plan.batches.some(batch => !batch.length)) throw new Error('색인 요청 예산이 바뀌었습니다.');
  const sourceIds = plan.data.references.map(s => s.id);
  await assertEmbeddingScopeCurrent(plan.projectScope ?? null, sourceIds, db);
  await verifyPlan(plan, db); signal.throwIfAborted();
  const token = crypto.randomUUID(); const deadlineAt = Date.now() + 120000;
  await db.transaction('rw', [db.embedding_spaces, db.embedding_manifests, db.projects, db.theory_documents, db.document_versions], async () => {
    await assertEmbeddingScopeInTransaction(plan.projectScope ?? null, db);
    const space = await db.embedding_spaces.get(plan.space.id);
    if (await db.embedding_manifests.get(plan.space.id)) throw new Error('완성 세대는 수정할 수 없습니다. 새 세대를 만드세요.');
    if (!space || !validSpace(space) || (space.runId && (space.deadlineAt ?? Infinity) >= Date.now())) throw new Error('색인 세대가 바뀌었거나 다른 탭에서 실행 중입니다.');
    await db.embedding_spaces.update(space.id, { runId: token, deadlineAt });
  });
  let count = 0;
  try {
    for (const batch of plan.batches) {
      signal.throwIfAborted(); if (Date.now() >= deadlineAt) throw new Error('색인 작업의 120초 시간 예산이 소진되었습니다.');
      const owner = await db.embedding_spaces.get(plan.space.id);
      if (owner?.runId !== token) throw new Error('색인 실행 소유권이 바뀌었습니다.');
      await assertEmbeddingScopeCurrent(plan.projectScope ?? null, sourceIds, db);
      await verifyPlan(plan, db);
      const timeoutSignal = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
      const response = await requestEmbeddings(plan.space, batch.map(s => s.text), key, AbortSignal.any([signal, timeoutSignal]));
      signal.throwIfAborted();
      await assertEmbeddingScopeCurrent(plan.projectScope ?? null, sourceIds, db);
      const vectors: EmbeddingVector[] = await Promise.all(batch.map(async (span, i) => {
        const vector = { spaceId: plan.space.id, sourceId: span.sourceId,
          sourceHash: plan.data.references.find(s => s.id === span.sourceId)!.contentHash, spanId: span.id, spanHash: span.contentHash,
          values: response.vectors[i], createdAt: Date.now() };
        return { ...vector, vectorHash: await embeddingVectorHash(vector) };
      }));
      await db.transaction('rw', [db.embedding_spaces, db.embedding_vectors, db.embedding_manifests, db.references, db.reference_spans, db.projects, db.theory_documents, db.document_versions], async () => {
        await assertEmbeddingScopeInTransaction(plan.projectScope ?? null, db);
        const owner = await db.embedding_spaces.get(plan.space.id);
        if (owner?.runId !== token || Date.now() >= deadlineAt) throw new Error('색인 실행 소유권/기한이 바뀌었습니다.');
        if (await db.embedding_manifests.get(plan.space.id)) throw new Error('완성 세대는 수정할 수 없습니다.');
        for (const vector of vectors) {
          const source = await db.references.get(vector.sourceId), span = await db.reference_spans.get(vector.spanId);
          if (source?.contentHash !== vector.sourceHash || span?.contentHash !== vector.spanHash) throw new Error('원문이 변경되어 임베딩을 게시하지 않습니다.');
        }
        await db.embedding_vectors.bulkPut(vectors);
      });
      count += batch.length; onProgress(count, response.promptTokens);
    }
  } finally {
    await db.transaction('rw', db.embedding_spaces, async () => {
      if ((await db.embedding_spaces.get(plan.space.id))?.runId === token) await db.embedding_spaces.update(plan.space.id, { runId: null, deadlineAt: null });
    });
  }
}
