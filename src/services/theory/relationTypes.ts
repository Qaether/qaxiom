export interface ClaimAnchor {
  type: 'claim'; runId: string; claimId: string; versionId: string; versionHash: string;
  blockId: string; blockHash: string; quote: string;
}
export interface ReferenceAnchor {
  type: 'reference'; sourceId: string; sourceHash: string; spanId: string; spanHash: string; quote: string;
}
export const RELATION_KINDS = ['depends_on', 'defines', 'supports', 'contradicts'] as const;
export const COMPATIBILITY_LABELS = ['compatible', 'conflict_candidate', 'different_scope', 'insufficient_evidence'] as const;
export interface CompatibilityAssessment {
  label: typeof COMPATIBILITY_LABELS[number]; theoryConditions: string; referenceConditions: string;
}
export interface ResearchRelation {
  id: string; documentId: string; from: ClaimAnchor; to: ClaimAnchor | ReferenceAnchor;
  kind: typeof RELATION_KINDS[number]; dependencyType: 'proof' | 'concept' | null;
  assessment: CompatibilityAssessment | null; note: string; createdAt: number;
  retractedAt: number | null; retractionNote: string; relationHash: string;
  externalReviewOrigin?: { runId: string; pairId: string; contextHash: string; assessmentHash: string };
}
export interface RelationData { researchRelations: ResearchRelation[] }
export const anchorKey = (anchor: ClaimAnchor | ReferenceAnchor) => anchor.type === 'claim'
  ? JSON.stringify(['claim', anchor.runId, anchor.claimId]) : JSON.stringify(['reference', anchor.sourceId, anchor.spanId]);
