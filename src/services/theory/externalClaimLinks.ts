import { qaxiomDatabase, type QaxiomDatabase } from '../database';
import { hashText } from './blocks';
import { acceptedExternalClaimHash, loadProjectExternalClaims, type ExternalClaim, type ExternalClaimData } from './externalClaims';

export const EXTERNAL_LINK_KINDS = ['same_concept_candidate', 'different_scope_candidate', 'conflict_candidate', 'related'] as const;
export interface ExternalClaimLink {
  id: string;
  fromProjectId: string;
  toProjectId: string;
  fromClaimId: string;
  toClaimId: string;
  fromAcceptedHash: string;
  toAcceptedHash: string;
  kind: typeof EXTERNAL_LINK_KINDS[number];
  fromConditions: string;
  toConditions: string;
  note: string;
  createdAt: number;
  retractedAt: number | null;
  retractionNote: string;
  linkHash: string;
}
export interface ExternalClaimLinkData { externalClaimLinks: ExternalClaimLink[] }
type UnsignedLink = Omit<ExternalClaimLink, 'linkHash'>;
export const externalClaimLinkHash = (link: UnsignedLink) => hashText(JSON.stringify({
  id: link.id, fromProjectId: link.fromProjectId, toProjectId: link.toProjectId,
  fromClaimId: link.fromClaimId, toClaimId: link.toClaimId, fromAcceptedHash: link.fromAcceptedHash,
  toAcceptedHash: link.toAcceptedHash, kind: link.kind, fromConditions: link.fromConditions,
  toConditions: link.toConditions, note: link.note, createdAt: link.createdAt,
  retractedAt: link.retractedAt, retractionNote: link.retractionNote
}));
function fail(): never { throw new Error('교차 프로젝트 외부 주장 관계의 원문·승인 계보가 올바르지 않습니다. 기존 작업공간을 유지합니다.'); }
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const pairKey = (a: string, b: string, kind: string) => JSON.stringify([[a, b].sort(), kind]);

export function parseExternalClaimLinkData(input: unknown, claims: ExternalClaimData): ExternalClaimLinkData {
  if (!input || typeof input !== 'object' || !Array.isArray((input as ExternalClaimLinkData).externalClaimLinks)
    || (input as ExternalClaimLinkData).externalClaimLinks.length > 10000) fail();
  const claimMap = new Map(claims.externalClaims.map(c => [c.id, c]));
  const rows = (input as ExternalClaimLinkData).externalClaimLinks.map(row => {
    if (!row || typeof row !== 'object' || ![row.id, row.fromProjectId, row.toProjectId, row.fromClaimId, row.toClaimId,
      row.fromAcceptedHash, row.toAcceptedHash, row.fromConditions, row.toConditions, row.note, row.linkHash].every(text)
      || !EXTERNAL_LINK_KINDS.includes(row.kind) || row.fromProjectId === row.toProjectId || row.fromClaimId === row.toClaimId
      || [row.fromConditions, row.toConditions, row.note].some(v => v.length > 2000)
      || !/^[a-f0-9]{64}$/.test(row.linkHash) || !/^[a-f0-9]{64}$/.test(row.fromAcceptedHash)
      || !/^[a-f0-9]{64}$/.test(row.toAcceptedHash) || !time(row.createdAt)
      || !(row.retractedAt === null ? row.retractionNote === '' : time(row.retractedAt) && row.retractedAt >= row.createdAt && text(row.retractionNote) && row.retractionNote.length <= 2000)) fail();
    const from = claimMap.get(row.fromClaimId), to = claimMap.get(row.toClaimId);
    if (!from || !to || from.projectId !== row.fromProjectId || to.projectId !== row.toProjectId
      || row.createdAt < from.acceptedAt || row.createdAt < to.acceptedAt) fail();
    return { ...row };
  });
  if (new Set(rows.map(r => r.id)).size !== rows.length) fail();
  const active = new Set<string>();
  for (const row of rows) if (row.retractedAt === null) {
    const key = pairKey(row.fromClaimId, row.toClaimId, row.kind);
    if (active.has(key)) fail(); active.add(key);
  }
  return { externalClaimLinks: rows };
}
export async function verifyExternalClaimLinkHashes(data: ExternalClaimLinkData, claims: ExternalClaimData) {
  const map = new Map(claims.externalClaims.map(c => [c.id, c]));
  for (const row of data.externalClaimLinks) {
    const from = map.get(row.fromClaimId), to = map.get(row.toClaimId);
    if (!from || !to || await acceptedExternalClaimHash(from) !== row.fromAcceptedHash
      || await acceptedExternalClaimHash(to) !== row.toAcceptedHash || await externalClaimLinkHash(row) !== row.linkHash) fail();
  }
}

export interface ExternalClaimLinkInput {
  fromProjectId: string; toProjectId: string; fromClaimId: string; toClaimId: string;
  kind: ExternalClaimLink['kind']; fromConditions: string; toConditions: string; note: string;
}
async function anchorSnapshot(row: ExternalClaim, db: QaxiomDatabase) {
  return db.transaction('r', [db.projects, db.external_claims, db.theory_documents, db.document_versions, db.review_runs, db.references, db.reference_spans], async () => {
    const claim = await db.external_claims.get(row.id), project = await db.projects.get(row.projectId);
    const document = await db.theory_documents.get(row.documentId), run = await db.review_runs.get(row.runId);
    const version = run && await db.document_versions.get(run.versionId);
    const source = await db.references.get(row.sourceId), span = await db.reference_spans.get(row.spanId);
    const allVersionHashes = (await db.document_versions.toArray()).map(v => v.contentHash).sort();
    return JSON.stringify({ claim, project, document, run, version, source, span, allVersionHashes });
  });
}
export async function prepareExternalClaimLink(input: ExternalClaimLinkInput, db: QaxiomDatabase = qaxiomDatabase) {
  if (!input.fromProjectId || !input.toProjectId || input.fromProjectId === input.toProjectId
    || !input.fromClaimId || !input.toClaimId || input.fromClaimId === input.toClaimId
    || !EXTERNAL_LINK_KINDS.includes(input.kind)
    || [input.fromConditions, input.toConditions, input.note].some(v => !text(v) || v.length > 2000))
    throw new Error('서로 다른 프로젝트의 현재 채택 주장·관계 종류·양쪽 조건·판단 사유를 입력하세요.');
  const from = (await loadProjectExternalClaims(input.fromProjectId, db)).find(e => e.row.id === input.fromClaimId);
  const to = (await loadProjectExternalClaims(input.toProjectId, db)).find(e => e.row.id === input.toClaimId);
  if (!from || !to || from.status !== 'current' || to.status !== 'current') throw new Error('양쪽 프로젝트의 현재 범위 채택 주장만 연결할 수 있습니다.');
  const frozen = structuredClone(input);
  return { input: frozen, from, to, fromAcceptedHash: await acceptedExternalClaimHash(from.row),
    toAcceptedHash: await acceptedExternalClaimHash(to.row),
    fromSnapshot: await anchorSnapshot(from.row, db), toSnapshot: await anchorSnapshot(to.row, db) };
}
export type ExternalClaimLinkPreview = Awaited<ReturnType<typeof prepareExternalClaimLink>>;

export async function approveExternalClaimLink(preview: ExternalClaimLinkPreview, db: QaxiomDatabase = qaxiomDatabase) {
  const fresh = await prepareExternalClaimLink(preview.input, db);
  if (JSON.stringify(fresh) !== JSON.stringify(preview)) throw new Error('외부 주장/원문/정책이 변경되었습니다. 미리보기를 다시 확인하세요.');
  const input = fresh.input;
  const unsigned: UnsignedLink = { id: crypto.randomUUID(), fromProjectId: input.fromProjectId, toProjectId: input.toProjectId,
    fromClaimId: input.fromClaimId, toClaimId: input.toClaimId, fromAcceptedHash: fresh.fromAcceptedHash,
    toAcceptedHash: fresh.toAcceptedHash, kind: input.kind, fromConditions: input.fromConditions.trim(),
    toConditions: input.toConditions.trim(), note: input.note.trim(),
    createdAt: Math.max(Date.now(), fresh.from.row.acceptedAt, fresh.to.row.acceptedAt), retractedAt: null, retractionNote: '' };
  const row: ExternalClaimLink = { ...unsigned, linkHash: await externalClaimLinkHash(unsigned) };
  await db.transaction('rw', [db.external_claim_links, db.external_claims, db.projects, db.theory_documents, db.document_versions,
    db.review_runs, db.references, db.reference_spans], async () => {
    for (const [claim, expected] of [[fresh.from.row, fresh.fromSnapshot], [fresh.to.row, fresh.toSnapshot]] as const) {
      const current = await db.external_claims.get(claim.id), project = await db.projects.get(claim.projectId);
      const document = await db.theory_documents.get(claim.documentId), run = await db.review_runs.get(claim.runId);
      const version = run && await db.document_versions.get(run.versionId);
      const source = await db.references.get(claim.sourceId), span = await db.reference_spans.get(claim.spanId);
      const allVersionHashes = (await db.document_versions.toArray()).map(v => v.contentHash).sort();
      if (JSON.stringify({ claim: current, project, document, run, version, source, span, allVersionHashes }) !== expected)
        throw new Error('교차 프로젝트 원문/정책이 변경되었습니다. 다시 확인하세요.');
    }
    if (await db.external_claim_links.count() >= 10000) throw new Error('교차 프로젝트 관계 10,000개 한도를 넘습니다.');
    const existing = await db.external_claim_links.where('fromClaimId').equals(input.fromClaimId).toArray();
    const reverse = await db.external_claim_links.where('fromClaimId').equals(input.toClaimId).toArray();
    if ([...existing, ...reverse].some(link => link.retractedAt === null && pairKey(link.fromClaimId, link.toClaimId, link.kind) === pairKey(input.fromClaimId, input.toClaimId, input.kind)))
      throw new Error('같은 교차 프로젝트 관계가 이미 있습니다.');
    await db.external_claim_links.add(row);
  });
  return row;
}

export async function retractExternalClaimLink(id: string, note: string, db: QaxiomDatabase = qaxiomDatabase) {
  if (!note.trim() || note.length > 2000) throw new Error('철회 사유를 1–2,000자로 입력하세요.');
  const before = await db.external_claim_links.get(id);
  if (!before || before.retractedAt !== null) throw new Error('교차 프로젝트 관계가 없거나 이미 철회되었습니다.');
  if (await externalClaimLinkHash(before) !== before.linkHash) throw new Error('교차 프로젝트 관계 hash가 일치하지 않습니다.');
  const unsigned = { ...before, retractedAt: Math.max(Date.now(), before.createdAt), retractionNote: note.trim() };
  const after = { ...unsigned, linkHash: await externalClaimLinkHash(unsigned) };
  await db.transaction('rw', db.external_claim_links, async () => {
    if (JSON.stringify(await db.external_claim_links.get(id)) !== JSON.stringify(before)) throw new Error('관계가 다른 탭에서 변경되었습니다.');
    await db.external_claim_links.put(after);
  });
  return after;
}

export async function loadExternalClaimLinks(projectId: string, db: QaxiomDatabase = qaxiomDatabase) {
  const rows = await db.transaction('r', db.external_claim_links, async () => {
    const from = await db.external_claim_links.where('fromProjectId').equals(projectId).toArray();
    const to = await db.external_claim_links.where('toProjectId').equals(projectId).toArray();
    return [...new Map([...from, ...to].map(row => [row.id, row])).values()];
  });
  const claims = await db.external_claims.bulkGet([...new Set(rows.flatMap(r => [r.fromClaimId, r.toClaimId]))]);
  const available = claims.filter((c): c is NonNullable<typeof c> => !!c);
  await verifyExternalClaimLinkHashes({ externalClaimLinks: rows }, { externalClaims: available });
  const current = new Map<string, boolean>();
  for (const id of [...new Set(rows.flatMap(r => [r.fromProjectId, r.toProjectId]))]) {
    if (!await db.projects.get(id)) continue;
    for (const entry of await loadProjectExternalClaims(id, db)) current.set(entry.row.id, entry.status === 'current');
  }
  return rows.map(row => ({ row, status: row.retractedAt !== null ? 'retracted' as const
    : current.get(row.fromClaimId) && current.get(row.toClaimId) ? 'current' as const : 'stale' as const,
    from: available.find(c => c.id === row.fromClaimId)!, to: available.find(c => c.id === row.toClaimId)! }))
    .sort((a, b) => b.row.createdAt - a.row.createdAt || a.row.id.localeCompare(b.row.id));
}
