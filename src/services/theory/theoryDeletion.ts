import { qaxiomDatabase, type QaxiomDatabase } from '../database';

export interface TheoryDeletionPreview {
  documentId: string;
  versionId: string;
  title: string;
  versionCount: number;
  blockCount: number;
  reviewCount: number;
  campaignCount: number;
  relationCount: number;
  projectAction: 'remove' | 'keep' | 'choose_representative';
  signature: string;
}

function containsPinnedId(value: unknown, ids: Set<string>, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return ids.has(value);
  if (!value || typeof value !== 'object' || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some(item => containsPinnedId(item, ids, seen));
}

async function readDeletionState(documentId: string, expectedVersionId: string, db: QaxiomDatabase) {
  const document = await db.theory_documents.get(documentId);
  if (!document || document.currentVersionId !== expectedVersionId) throw new Error('문서가 변경되었거나 이미 삭제되었습니다. 목록을 다시 확인하세요.');
  const project = await db.projects.get(document.projectId);
  if (!project) throw new Error('프로젝트를 찾을 수 없습니다. 삭제를 중단했습니다.');
  const [versions, blocks, runs, analyses, campaigns, relations, siblings] = await Promise.all([
    db.document_versions.where('documentId').equals(documentId).toArray(),
    db.document_blocks.where('documentId').equals(documentId).toArray(),
    db.review_runs.where('documentId').equals(documentId).toArray(),
    db.analysis_runs.where('documentId').equals(documentId).toArray(),
    db.review_campaigns.where('documentId').equals(documentId).toArray(),
    db.research_relations.where('documentId').equals(documentId).toArray(),
    db.theory_documents.where('projectId').equals(document.projectId).filter(row => row.id !== documentId).toArray()
  ]);
  if (!versions.some(version => version.id === expectedVersionId)
    || versions.some(version => version.documentId !== documentId)
    || blocks.some(block => block.documentId !== documentId || !versions.some(version => version.id === block.versionId))
    || project.canonicalDocumentId !== documentId && !siblings.some(row => row.id === project.canonicalDocumentId)) {
    throw new Error('문서 버전·문단·프로젝트 연결이 올바르지 않습니다. 삭제를 중단했습니다.');
  }
  if (campaigns.some(campaign => campaign.attempts.some(attempt => attempt.runId === null))) {
    throw new Error('이 문서에 종료되지 않은 검토 요청이 있습니다. 실행이 끝난 뒤 다시 시도하세요.');
  }
  if (analyses.some(run => run.status === 'running')) throw new Error('이 문서의 AI 분석이 진행 중입니다. 실행을 취소한 뒤 다시 시도하세요.');

  const ids = new Set([documentId, ...versions.map(row => row.id), ...blocks.map(row => row.id),
    ...runs.map(row => row.id), ...analyses.map(row => row.id), ...relations.map(row => row.id), ...campaigns.map(row => row.id),
    ...(!siblings.length ? [project.id] : [])]);
  const linkedSessions = await db.sessions.where('documentId').equals(documentId).toArray();
  if ((await Promise.all(linkedSessions.map(session => db.messages.where('sessionId').equals(session.id).count()))).some(count => count > 0)) {
    throw new Error('이 문서에 속한 대화가 남아 있습니다. 대화를 먼저 정리한 뒤 문서를 삭제하세요.');
  }
  const references = await db.references.toArray();
  if (references.some(row => row.originVersionId && ids.has(row.originVersionId))) {
    throw new Error('이 문서 버전에서 만든 레퍼런스가 남아 있습니다. 원문 계보를 보존하기 위해 삭제할 수 없습니다.');
  }
  if ((await db.external_claims.toArray()).some(row => row.documentId === documentId || containsPinnedId(row, ids))) {
    throw new Error('이 문서의 외부 주장 채택 기록이 남아 있습니다. 근거 이력을 보존하기 위해 삭제할 수 없습니다.');
  }
  const dependencyTables = [db.messages, db.external_claim_links, db.embedding_manifests,
    db.embedding_vectors, db.source_spans, db.wiki_pages, db.review_runs, db.analysis_runs, db.review_campaigns,
    db.research_relations, db.projects];
  for (const table of dependencyTables) {
    const rows = await table.toArray();
    const own = new Set(table === db.review_runs ? runs.map(row => row.id)
      : table === db.analysis_runs ? analyses.map(row => row.id)
      : table === db.review_campaigns ? campaigns.map(row => row.id)
        : table === db.research_relations ? relations.map(row => row.id)
          : table === db.projects ? [project.id] : []);
    if (rows.some(row => !own.has((row as { id?: string }).id ?? '') && containsPinnedId(row, ids))) {
      throw new Error('이 문서는 과거 답변·관계·프로젝트 또는 색인에서 참조 중입니다. 근거 이력을 보존하기 위해 삭제할 수 없습니다.');
    }
  }
  const nextRepresentative = siblings.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
  const preview: TheoryDeletionPreview = {
    documentId, versionId: expectedVersionId, title: versions.find(row => row.id === expectedVersionId)!.title,
    versionCount: versions.length, blockCount: blocks.length, reviewCount: runs.length + analyses.length,
    campaignCount: campaigns.length, relationCount: relations.length,
    projectAction: !nextRepresentative ? 'remove' : project.canonicalDocumentId === documentId ? 'choose_representative' : 'keep',
    signature: JSON.stringify([project, document.updatedAt, nextRepresentative?.id ?? null,
      ...[versions, blocks, runs, analyses, campaigns, relations, siblings, linkedSessions].map(rows => rows.map(row => row.id).sort())])
  };
  return { preview, nextRepresentative, projectId: project.id };
}

export async function prepareTheoryDeletion(documentId: string, expectedVersionId: string, db: QaxiomDatabase = qaxiomDatabase): Promise<TheoryDeletionPreview> {
  return db.transaction('r', db.tables, async () => (await readDeletionState(documentId, expectedVersionId, db)).preview);
}

/** Removes a document and its own history only when no independent record pins it. */
export async function deleteTheory(preview: TheoryDeletionPreview, db: QaxiomDatabase = qaxiomDatabase): Promise<TheoryDeletionPreview> {
  return db.transaction('rw', db.tables, async () => {
    const current = await readDeletionState(preview.documentId, preview.versionId, db);
    if (JSON.stringify(current.preview) !== JSON.stringify(preview)) throw new Error('삭제 대상의 기록이 변경되었습니다. 삭제 범위를 다시 확인하세요.');
    await db.sessions.where('documentId').equals(preview.documentId).delete();
    await db.document_blocks.where('documentId').equals(preview.documentId).delete();
    await db.document_versions.where('documentId').equals(preview.documentId).delete();
    await db.review_runs.where('documentId').equals(preview.documentId).delete();
    await db.analysis_runs.where('documentId').equals(preview.documentId).delete();
    await db.review_campaigns.where('documentId').equals(preview.documentId).delete();
    await db.research_relations.where('documentId').equals(preview.documentId).delete();
    await db.theory_documents.delete(preview.documentId);
    if (preview.projectAction === 'remove') {
      await db.projects.delete(current.projectId);
    } else if (preview.projectAction === 'choose_representative') {
      if (!current.nextRepresentative) throw new Error('대표 문서 상태가 변경되었습니다.');
      await db.projects.update(current.projectId, { canonicalDocumentId: current.nextRepresentative.id });
    }
    return preview;
  });
}
