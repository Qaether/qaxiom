import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { hashText } from '../theory/blocks';
import { loadReferenceSelection } from './references';
import { embeddingVectorHash, loadEmbeddingVectors } from './embeddings';
import { normalizeVector, validSpace, type EmbeddingManifest, type EmbeddingActivation } from './embeddingTypes';
import type { ReferenceData } from './types';
import { parseReferenceData } from './validation';
import { assertEmbeddingScopeInTransaction, type EmbeddingProjectScope } from './embeddingScope';

export const embeddingManifestHash = (manifest: Omit<EmbeddingManifest, 'manifestHash'>) => hashText(JSON.stringify({
  spaceId: manifest.spaceId, sources: manifest.sources, spans: manifest.spans
}));
const sortIds = <T extends { id: string }>(values: T[]) => values.sort((a, b) => a.id.localeCompare(b.id));

// Hash work happens outside Dexie transactions. Re-read all inputs before publication.
export async function prepareGenerationActivation(spaceId: string, sourceIds: string[], db: QaxiomDatabase = qaxiomDatabase) {
  const space = await db.embedding_spaces.get(spaceId);
  if (!space || !validSpace(space)) throw new Error('색인 세대가 없습니다.');
  if (space.runId && (space.deadlineAt ?? Infinity) >= Date.now()) throw new Error('다른 탭에서 색인을 실행 중입니다.');
  const sealed = await db.embedding_manifests.get(spaceId);
  if (sealed && await embeddingManifestHash(sealed) !== sealed.manifestHash) throw new Error('완성 색인 manifest 해시가 일치하지 않습니다.');
  const ids = sealed ? sealed.sources.map(s => s.id) : sourceIds;
  const data = await loadReferenceSelection(ids, db);
  const assetIds = data.references.flatMap(s => s.pdf ? [s.pdf.assetId] : []);
  const assets = (await db.pdf_assets.bulkGet(assetIds)).filter(asset => asset !== undefined);
  parseReferenceData(data, await db.document_versions.toArray(), assets);
  if (!data.references.length || !data.referenceSpans.length) throw new Error('활성화할 검색 가능한 원문이 없습니다.');
  const vectors = await loadEmbeddingVectors(space, data, db);
  if (vectors.length !== data.referenceSpans.length) throw new Error('전체 원문 구간의 의미 색인을 먼저 완료하세요. 부분 색인은 활성화하지 않습니다.');
  for (const source of data.references) if (await hashText(source.text) !== source.contentHash) throw new Error('원문 해시가 일치하지 않습니다.');
  const vectorMap = new Map(vectors.map(v => [v.spanId, v]));
  for (const span of data.referenceSpans) {
    const vector = vectorMap.get(span.id)!;
    if (await hashText(span.text) !== span.contentHash || await embeddingVectorHash(vector) !== vector.vectorHash) throw new Error('구간/벡터 해시가 일치하지 않습니다.');
    normalizeVector(vector.values, space.dimensions);
    if (Math.abs(Math.hypot(...vector.values) - 1) > 1e-6) throw new Error('벡터 정규화가 올바르지 않습니다.');
  }
  const payload = { spaceId, sources: sortIds(data.references.map(s => ({ id: s.id, contentHash: s.contentHash }))),
    spans: sortIds(data.referenceSpans.map(s => ({ id: s.id, sourceId: s.sourceId, contentHash: s.contentHash, vectorHash: vectorMap.get(s.id)!.vectorHash }))), createdAt: sealed?.createdAt ?? Date.now() };
  const manifest: EmbeddingManifest = { ...payload, manifestHash: await embeddingManifestHash(payload) };
  if (sealed && sealed.manifestHash !== manifest.manifestHash) throw new Error('완성 색인의 원문/벡터가 변경되었습니다. 새 세대가 필요합니다.');
  if (sourceIds.some(id => !manifest.sources.some(s => s.id === id))) throw new Error('선택 자료가 이 완성 세대의 범위를 벗어납니다. 새 세대를 만드세요.');
  const active = await db.embedding_activations.get('active');
  return { manifest, expectedRevision: active?.revision ?? 0, data, vectors };
}

export async function activateGeneration(preview: Awaited<ReturnType<typeof prepareGenerationActivation>>, db: QaxiomDatabase = qaxiomDatabase, projectScope: EmbeddingProjectScope | null = null) {
  // The approved manifest cannot gain additional sources or vectors during revalidation.
  const verified = await prepareGenerationActivation(preview.manifest.spaceId, preview.manifest.sources.map(s => s.id), db);
  if (verified.manifest.manifestHash !== preview.manifest.manifestHash) throw new Error('활성화 미리보기가 바뀌었습니다. 다시 확인하세요.');
  return db.transaction('rw', [db.embedding_spaces, db.embedding_vectors, db.embedding_manifests, db.embedding_activations, db.references, db.reference_spans, db.document_versions, db.theory_documents, db.projects], async () => {
    await assertEmbeddingScopeInTransaction(projectScope, db);
    const current = await db.embedding_activations.get('active');
    if ((current?.revision ?? 0) !== preview.expectedRevision) throw new Error('다른 탭에서 활성 세대를 변경했습니다. 다시 확인하세요.');
    const space = await db.embedding_spaces.get(preview.manifest.spaceId);
    if (!space || !validSpace(space) || (space.runId && (space.deadlineAt ?? Infinity) >= Date.now())) throw new Error('색인 실행 중에는 활성화할 수 없습니다.');
    const actual = await loadReferenceSelection(preview.manifest.sources.map(s => s.id), db);
    if (JSON.stringify(actual) !== JSON.stringify(verified.data)) throw new Error('원문 범위가 변경되었습니다.');
    for (const span of preview.manifest.spans) {
      const vector = await db.embedding_vectors.get([space.id, span.id]);
      const verifiedVector = verified.vectors.find(v => v.spanId === span.id);
      if (!vector || JSON.stringify(vector) !== JSON.stringify(verifiedVector)) throw new Error('벡터가 변경되었습니다.');
    }
    const sealed = await db.embedding_manifests.get(space.id);
    if (sealed && sealed.manifestHash !== preview.manifest.manifestHash) throw new Error('완성 세대는 수정할 수 없습니다.');
    const activation: EmbeddingActivation = { id: 'active', spaceId: space.id, manifestHash: preview.manifest.manifestHash,
      revision: preview.expectedRevision + 1, activatedAt: Date.now() };
    if (!sealed) await db.embedding_manifests.add(preview.manifest);
    await db.embedding_activations.put(activation);
    return activation;
  });
}

export async function loadActiveGeneration(sourceIds: string[], db: QaxiomDatabase = qaxiomDatabase) {
  const activation = await db.embedding_activations.get('active');
  if (!activation) throw new Error('전체 의미 색인을 먼저 완료하고 활성화하세요.');
  const verified = await prepareGenerationActivation(activation.spaceId, sourceIds, db);
  if (verified.manifest.manifestHash !== activation.manifestHash) throw new Error('활성 색인의 해시가 일치하지 않습니다.');
  const space = (await db.embedding_spaces.get(activation.spaceId))!;
  const data = await loadReferenceSelection(sourceIds, db), vectors = await loadEmbeddingVectors(space, data, db);
  await assertActiveGeneration(activation, data, db);
  return { activation, space, data, vectors };
}

export async function assertActiveGeneration(activation: EmbeddingActivation, data: ReferenceData, db: QaxiomDatabase = qaxiomDatabase) {
  const current = await db.embedding_activations.get('active');
  if (JSON.stringify(current) !== JSON.stringify(activation)) throw new Error('활성 세대가 변경되었습니다. 질문 미리보기를 다시 확인하세요.');
  const verified = await prepareGenerationActivation(activation.spaceId, data.references.map(s => s.id), db);
  const actual = await loadReferenceSelection(data.references.map(s => s.id), db);
  if (JSON.stringify(actual) !== JSON.stringify(data)) throw new Error('질문 미리보기의 원문/출처가 변경되었습니다. 다시 확인하세요.');
  if (verified.manifest.manifestHash !== activation.manifestHash
    || JSON.stringify(await db.embedding_activations.get('active')) !== JSON.stringify(activation)) throw new Error('활성 세대가 변경되었습니다.');
}
