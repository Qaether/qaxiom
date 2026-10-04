import { hashText } from './blocks';
import { acceptedExternalClaimHash, type ExternalClaimData } from './externalClaims';

// Legacy cross-project links remain in backups, but new links cannot be created.
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
