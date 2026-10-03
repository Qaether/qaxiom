import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { hashText } from './blocks';
import { loadTheory } from './documents';
import { loadReferenceSelection } from '../retrieval/references';
import { anchorKey, type ClaimAnchor, type ReferenceAnchor, type ResearchRelation } from './relationTypes';
import { parseRelationData, relationHash, verifyRelationHashes } from './relationValidation';
import type { ReviewRun } from './reviewTypes';
import { parseReferenceData } from '../retrieval/validation';
import { assertExternalReviewCurrent } from './externalReview';
import { assertProjectSources } from './projectSources';

export const claimAnchor = (run: ReviewRun, claimId: string): ClaimAnchor => {
  const claim = run.claims.find(c => c.id === claimId);
  if (!claim || run.status !== 'complete' || claim.acceptance !== 'accepted') throw new Error('먼저 현재 버전의 주장 후보를 채택하세요.');
  return { type: 'claim', runId: run.id, claimId, versionId: run.versionId, versionHash: run.versionHash,
    blockId: claim.blockId, blockHash: claim.blockHash, quote: claim.statement };
};
export type RelationProposal = Omit<ResearchRelation, 'id' | 'createdAt' | 'retractedAt' | 'retractionNote' | 'relationHash'>;
export async function validateRelationProposal(proposal: RelationProposal, db: QaxiomDatabase) {
  const snapshot = await loadTheory(proposal.documentId, db);
  const runs = await db.review_runs.where('documentId').equals(proposal.documentId).toArray();
  if (proposal.externalReviewOrigin) {
    const originRun = runs.find(r => r.id === proposal.externalReviewOrigin!.runId);
    if (!originRun) throw new Error('외부 대조 계보가 없습니다.');
    await assertExternalReviewCurrent(originRun, db);
  }
  for (const anchor of [proposal.from, proposal.to]) if (anchor.type === 'claim') {
    const run = runs.find(r => r.id === anchor.runId);
    if (!run || run.versionId !== snapshot.version.id || JSON.stringify(claimAnchor(run, anchor.claimId)) !== JSON.stringify(anchor)) throw new Error('주장 채택 또는 정본 버전이 바뀌었습니다. 관계를 다시 확인하세요.');
    const block = snapshot.blocks.find(b => b.id === anchor.blockId);
    if (!block || await hashText(block.text) !== anchor.blockHash || await hashText(snapshot.version.markdown) !== anchor.versionHash) throw new Error('주장 원문 해시가 일치하지 않습니다.');
  }
  const data = proposal.to.type === 'reference' ? await loadReferenceSelection([proposal.to.sourceId], db) : { references: [], referenceSpans: [] };
  const versions = await db.document_versions.toArray();
  const project = await db.projects.get(snapshot.document.projectId);
  if (proposal.to.type === 'reference') {
    const target = proposal.to;
    const source = data.references[0], span = data.referenceSpans.find(s => s.id === target.spanId);
    if (!span || await hashText(source.text) !== target.sourceHash || await hashText(span.text) !== target.spanHash) throw new Error('레퍼런스 원문 해시가 일치하지 않습니다.');
    const assets = (await db.pdf_assets.bulkGet(data.references.flatMap(s => s.pdf ? [s.pdf.assetId] : []))).filter(a => a !== undefined);
    parseReferenceData(data, versions, assets);
    if (proposal.externalReviewOrigin && (source.role !== 'external' || source.originVersionId !== null || versions.some(v => v.contentHash === source.contentHash))) throw new Error('독립 외부 출처가 아닙니다.');
  }
  const temporary = { ...proposal, id: 'preview', createdAt: 0, retractedAt: null, retractionNote: '', relationHash: 'preview' };
  parseRelationData({ researchRelations: [temporary] }, { projects: [], theoryDocuments: [snapshot.document], documentVersions: snapshot.history, documentBlocks: snapshot.blocks }, { reviewRuns: runs }, data);
  const signed = { ...temporary, relationHash: await relationHash(temporary) };
  await verifyRelationHashes({ researchRelations: [signed] }, runs);
  return { snapshot, runs, data, versions, project };
}
export async function approveRelation(input: RelationProposal, db: QaxiomDatabase = qaxiomDatabase) {
  const proposal = structuredClone(input);
  const verified = await validateRelationProposal(proposal, db);
  const row = { ...proposal, id: crypto.randomUUID(), createdAt: Date.now(), retractedAt: null, retractionNote: '' };
  const relation: ResearchRelation = { ...row, relationHash: await relationHash(row) };
  return db.transaction('rw', [db.projects, db.research_relations, db.theory_documents, db.document_versions, db.document_blocks, db.review_runs, db.references, db.reference_spans], async () => {
    if ((await db.theory_documents.get(proposal.documentId))?.currentVersionId !== verified.snapshot.version.id) throw new Error('정본 버전이 바뀌었습니다.');
    for (const anchor of [proposal.from, proposal.to]) if (anchor.type === 'claim') {
      const run = await db.review_runs.get(anchor.runId);
      const block = await db.document_blocks.get([anchor.versionId, anchor.blockId]);
      const version = await db.document_versions.get(anchor.versionId);
      if (!run || JSON.stringify(claimAnchor(run, anchor.claimId)) !== JSON.stringify(anchor)
        || JSON.stringify(block) !== JSON.stringify(verified.snapshot.blocks.find(b => b.id === anchor.blockId))
        || JSON.stringify(version) !== JSON.stringify(verified.snapshot.version)) throw new Error('주장 원문/채택 상태가 변경되었습니다.');
    }
    if (proposal.to.type === 'reference') {
      const target = proposal.to;
      const source = await db.references.get(target.sourceId), span = await db.reference_spans.get(target.spanId);
      if (!source || JSON.stringify(source) !== JSON.stringify(verified.data.references[0])
        || JSON.stringify(span) !== JSON.stringify(verified.data.referenceSpans.find(s => s.id === target.spanId))) throw new Error('레퍼런스 원문이 변경되었습니다.');
    }
    if (proposal.externalReviewOrigin) {
      const document = await db.theory_documents.get(proposal.documentId), project = document && await db.projects.get(document.projectId);
      if (document?.projectId !== verified.snapshot.document.projectId || JSON.stringify(project?.sourcePolicy) !== JSON.stringify(verified.project?.sourcePolicy)) throw new Error('프로젝트 자료 정책/소속이 변경되었습니다.');
      assertProjectSources(project, proposal.to.type === 'reference' ? [proposal.to.sourceId] : []);
      const o = proposal.externalReviewOrigin;
      if (JSON.stringify(await db.review_runs.get(o.runId)) !== JSON.stringify(verified.runs.find(r => r.id === o.runId))
        || JSON.stringify(await db.document_versions.toArray()) !== JSON.stringify(verified.versions)) throw new Error('외부 대조 결과/독립 출처 계보가 변경되었습니다.');
    }
    const existing = await db.research_relations.where('documentId').equals(proposal.documentId).toArray();
    if (existing.length >= 1000) throw new Error('문서별 관계 1,000개 한도를 넘습니다.');
    if (await db.research_relations.count() >= 10000) throw new Error('작업공간 관계 10,000개 한도를 넘습니다.');
    if (existing.some(r => r.retractedAt === null && anchorKey(r.from) === anchorKey(proposal.from) && anchorKey(r.to) === anchorKey(proposal.to) && r.kind === proposal.kind && r.dependencyType === proposal.dependencyType)) throw new Error('같은 승인 관계가 이미 있습니다. 기존 기록을 철회한 뒤 다시 승인하세요.');
    await db.research_relations.add(relation); return relation;
  });
}
export async function retractRelation(id: string, note: string, db: QaxiomDatabase = qaxiomDatabase) {
  if (!note.trim() || note.length > 2000) throw new Error('철회 사유를 1–2,000자로 입력하세요.');
  const before = await db.research_relations.get(id);
  if (!before || before.retractedAt !== null) throw new Error('관계가 없거나 이미 철회되었습니다.');
  if (await relationHash(before) !== before.relationHash) throw new Error('관계 해시가 일치하지 않습니다.');
  const after = { ...before, retractedAt: Date.now(), retractionNote: note.trim() };
  after.relationHash = await relationHash(after);
  await db.transaction('rw', db.research_relations, async () => {
    if (JSON.stringify(await db.research_relations.get(id)) !== JSON.stringify(before)) throw new Error('다른 탭에서 관계를 변경했습니다.');
    await db.research_relations.put(after);
  });
  return after;
}
export async function loadRelationWiki(documentId: string, db: QaxiomDatabase = qaxiomDatabase) {
  const wiki = await db.transaction('r', [db.theory_documents, db.document_versions, db.document_blocks, db.review_runs, db.research_relations, db.references, db.reference_spans], async () => {
    const snapshot = await loadTheory(documentId, db), runs = await db.review_runs.where('documentId').equals(documentId).toArray();
    const relations = await db.research_relations.where('documentId').equals(documentId).toArray();
    const versions = await db.document_versions.toArray();
    const references = (await db.references.toArray()).map(source => {
      const own = versions.find(v => v.contentHash === source.contentHash);
      return own ? { ...source, role: 'theory_snapshot' as const, originVersionId: own.id } : source;
    }), spans = await db.reference_spans.toArray();
    const entries = relations.map(relation => {
      const anchors = [relation.from, relation.to].filter((a): a is ClaimAnchor => a.type === 'claim');
      const status: 'retracted' | 'stale' | 'claim_unaccepted' | 'active' = relation.retractedAt !== null ? 'retracted' : anchors.some(a => a.versionId !== snapshot.version.id) ? 'stale'
        : anchors.some(a => runs.find(r => r.id === a.runId)?.claims.find(c => c.id === a.claimId)?.acceptance !== 'accepted') ? 'claim_unaccepted' : 'active';
      const source = relation.to.type === 'reference' ? references.find(s => s.id === (relation.to as ReferenceAnchor).sourceId) : null;
      const independent = !!source && source.role === 'external' && !versions.some(v => v.contentHash === source.contentHash);
      return { relation, status, independent, source: source ?? null };
    });
    return { snapshot, runs, references, spans, entries };
  });
  await verifyRelationHashes({ researchRelations: wiki.entries.map(e => e.relation) }, wiki.runs);
  return wiki;
}
