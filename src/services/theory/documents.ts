import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { buildBlocks, hashText } from './blocks';
import { EMPTY_CONTRACT, type ContractAnchors, type DocumentBlock, type DocumentVersion, type ResearchContract, type TheorySnapshot } from './types';

const CONFLICT = '다른 작업에서 문서가 변경되었습니다. 최신 버전을 다시 열어 수정 내용을 비교해 주세요.';

export interface VersionInput {
  title: string;
  markdown: string;
  contract: ResearchContract;
  contractAnchors?: ContractAnchors;
}

export function validateContractAnchors(anchors: ContractAnchors, contract: ResearchContract, blocks: DocumentBlock[]): ContractAnchors {
  if (!anchors || typeof anchors !== 'object' || Array.isArray(anchors)) throw new Error('연구 기준 원문 연결 형식이 올바르지 않습니다.');
  const result: ContractAnchors = {};
  for (const [field, anchor] of Object.entries(anchors)) {
    if (!(field in EMPTY_CONTRACT) || !contract[field as keyof ResearchContract]?.trim()
      || !anchor || typeof anchor.blockId !== 'string' || typeof anchor.blockHash !== 'string')
      throw new Error('연구 기준 원문 연결이 비어 있거나 기준 항목과 맞지 않습니다.');
    const block = blocks.find(item => item.id === anchor.blockId && item.contentHash === anchor.blockHash);
    if (!block) throw new Error('연구 기준에 연결한 원문 블록이 현재 문서 버전과 다릅니다. 본문을 저장한 뒤 다시 연결하세요.');
    result[field as keyof ResearchContract] = { blockId: block.id, blockHash: block.contentHash };
  }
  return result;
}

function validateInput(input: VersionInput) {
  if (!input.title.trim() || !input.markdown.trim()) throw new Error('문서 제목과 본문을 입력해 주세요.');
  if (input.markdown.length > 2_000_000) throw new Error('문서 본문은 200만 자 이하여야 합니다.');
  for (const key of Object.keys(EMPTY_CONTRACT) as (keyof ResearchContract)[]) {
    if (typeof input.contract[key] !== 'string') throw new Error('연구 기준 형식이 올바르지 않습니다.');
  }
}

export async function createTheory(input: VersionInput, db: QaxiomDatabase = qaxiomDatabase) {
  validateInput(input);
  const documentId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const blocks = await buildBlocks(input.markdown, documentId, id);
  const version: DocumentVersion = {
    title: input.title.trim(), markdown: input.markdown, contract: { ...input.contract },
    contractAnchors: validateContractAnchors(input.contractAnchors ?? {}, input.contract, blocks),
    id, documentId, number: 1, parentVersionId: null, restoredFromVersionId: null,
    contentHash: await hashText(input.markdown), createdAt
  };
  await db.transaction('rw', [db.projects, db.theory_documents, db.document_versions, db.document_blocks], async () => {
    await db.projects.add({ id: projectId, title: version.title, canonicalDocumentId: documentId, createdAt });
    await db.theory_documents.add({ id: documentId, projectId, role: 'theory', currentVersionId: id, createdAt, updatedAt: createdAt });
    await db.document_versions.add(version);
    await db.document_blocks.bulkAdd(blocks);
  });
  return loadTheory(documentId, db);
}

export async function loadTheory(documentId: string, db: QaxiomDatabase = qaxiomDatabase): Promise<TheorySnapshot> {
  return db.transaction('r', [db.theory_documents, db.document_versions, db.document_blocks], async () => {
    const document = await db.theory_documents.get(documentId);
    if (!document) throw new Error('문서를 찾을 수 없습니다.');
    const version = await db.document_versions.get(document.currentVersionId);
    if (!version) throw new Error('문서 버전을 찾을 수 없습니다.');
    const history = await db.document_versions.where('documentId').equals(documentId).sortBy('number');
    const blocks = await db.document_blocks.where('versionId').equals(version.id).sortBy('position');
    validateContractAnchors(version.contractAnchors, version.contract, blocks);
    return { document, version, history, blocks };
  });
}

export async function listTheories(db: QaxiomDatabase = qaxiomDatabase) {
  return db.transaction('r', [db.theory_documents, db.document_versions], async () => {
    const documents = await db.theory_documents.orderBy('updatedAt').reverse().toArray();
    const versions = await db.document_versions.bulkGet(documents.map(document => document.currentVersionId));
    return documents.map((document, index) => ({ document, version: versions[index]! }));
  });
}

export async function saveTheoryVersion(
  documentId: string, baseVersionId: string, input: VersionInput,
  db: QaxiomDatabase = qaxiomDatabase, restoredFromVersionId: string | null = null
) {
  validateInput(input);
  const current = await loadTheory(documentId, db);
  if (current.version.id !== baseVersionId) throw new Error(CONFLICT);
  const contentHash = await hashText(input.markdown);
  const id = crypto.randomUUID();
  const blocks = await buildBlocks(input.markdown, documentId, id, current.blocks);
  const proposedAnchors = input.contractAnchors ?? Object.fromEntries(Object.entries(current.version.contractAnchors).filter(([field, anchor]) =>
    input.contract[field as keyof ResearchContract] === current.version.contract[field as keyof ResearchContract]
      && blocks.some(block => block.id === anchor.blockId && block.contentHash === anchor.blockHash)));
  const contractAnchors = validateContractAnchors(proposedAnchors, input.contract, blocks);
  if (!restoredFromVersionId && contentHash === current.version.contentHash
    && input.title.trim() === current.version.title
    && JSON.stringify(input.contract) === JSON.stringify(current.version.contract)
    && JSON.stringify(contractAnchors) === JSON.stringify(current.version.contractAnchors)) return current;
  const version: DocumentVersion = {
    title: input.title.trim(), markdown: input.markdown, contract: { ...input.contract }, contractAnchors, id, documentId,
    parentVersionId: baseVersionId, restoredFromVersionId, number: current.version.number + 1,
    contentHash, createdAt: Date.now()
  };
  await db.transaction('rw', [db.theory_documents, db.document_versions, db.document_blocks], async () => {
    const document = await db.theory_documents.get(documentId);
    if (document?.currentVersionId !== baseVersionId) throw new Error(CONFLICT);
    if (restoredFromVersionId) {
      const old = await db.document_versions.get(restoredFromVersionId);
      if (old?.documentId !== documentId) throw new Error('복원할 버전이 이 문서에 속하지 않습니다.');
    }
    await db.document_versions.add(version);
    await db.document_blocks.bulkAdd(blocks);
    await db.theory_documents.update(documentId, { currentVersionId: id, updatedAt: version.createdAt });
  });
  return loadTheory(documentId, db);
}

export async function restoreTheoryVersion(documentId: string, baseVersionId: string, oldVersionId: string, db: QaxiomDatabase = qaxiomDatabase) {
  const old = await db.document_versions.get(oldVersionId);
  if (!old || old.documentId !== documentId) throw new Error('복원할 버전을 찾을 수 없습니다.');
  return saveTheoryVersion(documentId, baseVersionId, { title: old.title, markdown: old.markdown, contract: old.contract }, db, old.id);
}
