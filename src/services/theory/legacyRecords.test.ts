// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { QaxiomDatabase } from '../database';
import { importReference } from '../retrieval/references';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';
import { createTheory } from './documents';
import { prepareExternalReview, parseExternalResponse } from './externalReview';
import { externalClaimHash, acceptedExternalClaimHash, type ExternalClaim } from './externalClaims';
import { externalClaimLinkHash, type ExternalClaimLink } from './externalClaimLinks';
import { externalAssessmentHash } from './relationValidation';
import { reviewSkeleton } from './reviews';
import { EMPTY_CONTRACT } from './types';

const db = new QaxiomDatabase(`legacy-records-${crypto.randomUUID()}`);
const target = new QaxiomDatabase(`legacy-records-target-${crypto.randomUUID()}`);
afterEach(async () => { await db.delete(); await target.delete(); });

async function seedClaim(title: string): Promise<ExternalClaim> {
  const snapshot = await createTheory({ title, markdown: `${title} positive.`, contract: EMPTY_CONTRACT }, db);
  const quote = `Independent ${title} result.`;
  const source = (await importReference(`${title}.md`, quote, 'external', db)).source;
  const span = (await db.reference_spans.where('sourceId').equals(source.id).first())!;
  const prepared = await prepareExternalReview(snapshot, [{ blockId: snapshot.blocks[0].id, spanId: span.id,
    theoryConditions: 'all', referenceConditions: 'measured' }], db);
  const pairId = prepared.context.pairs[0].id;
  const parsed = parseExternalResponse(JSON.stringify({ checkedPairIds: [pairId], limitations: [], assessments: [{ pairId,
    label: 'different_scope', theoryQuote: `${title} positive.`, referenceQuote: quote,
    theoryConditions: 'all', referenceConditions: 'measured', explanation: 'scope',
    referenceClaim: { statement: `${title} result`, evidenceQuote: quote, kind: 'empirical',
      basis: 'author_statement', conditions: 'measured' } }] }), prepared.context);
  const run = reviewSkeleton(snapshot, 'external-v1', [], 'mock');
  run.external = { context: prepared.context, checkedPairIds: parsed.checkedPairIds, assessments: parsed.assessments };
  await db.review_runs.add(run);
  const evidence = prepared.context.evidence[0], assessment = parsed.assessments[0];
  const unsigned = { id: crypto.randomUUID(), projectId: snapshot.document.projectId, documentId: snapshot.document.id,
    runId: run.id, pairId, assessmentHash: await externalAssessmentHash(assessment), sourceId: source.id,
    sourceHash: source.contentHash, spanId: span.id, spanHash: span.contentHash, claim: assessment.referenceClaim!,
    acceptedAt: Date.now(), retractedAt: null, retractionNote: '' };
  const row: ExternalClaim = { ...unsigned, recordHash: await externalClaimHash(unsigned) };
  expect(evidence.sourceId).toBe(source.id);
  await db.external_claims.add(row);
  return row;
}

it('keeps historical claims and links in backups and rejects a forged link without replacing the workspace', async () => {
  const a = await seedClaim('A'), b = await seedClaim('B');
  const unsigned = { id: crypto.randomUUID(), fromProjectId: a.projectId, toProjectId: b.projectId,
    fromClaimId: a.id, toClaimId: b.id, fromAcceptedHash: await acceptedExternalClaimHash(a),
    toAcceptedHash: await acceptedExternalClaimHash(b), kind: 'related' as const,
    fromConditions: 'all', toConditions: 'measured', note: 'historical user decision',
    createdAt: Math.max(Date.now(), a.acceptedAt, b.acceptedAt), retractedAt: null, retractionNote: '' };
  const link: ExternalClaimLink = { ...unsigned, linkHash: await externalClaimLinkHash(unsigned) };
  await db.external_claim_links.add(link);
  const backup = await createWorkspaceBundle(db);
  await restoreWorkspaceBundle(backup, target);
  expect(await target.external_claims.count()).toBe(2);
  expect(await target.external_claim_links.get(link.id)).toEqual(link);
  const forged = structuredClone(backup);
  forged.data.externalClaimLinks[0].note = 'forged';
  await expect(restoreWorkspaceBundle(forged, target)).rejects.toThrow();
  expect(await target.external_claim_links.get(link.id)).toEqual(link);
});
