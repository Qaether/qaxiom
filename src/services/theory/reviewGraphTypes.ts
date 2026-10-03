import type { ResearchRelation } from './relationTypes';
export interface ReviewGraphContext {
  version: 1; versionId: string; versionHash: string; graphFingerprint: string; contextHash: string;
  targetBlockIds: string[]; premiseBlockIds: string[]; relationSnapshots: ResearchRelation[];
  excludedCounts: { stale: number; retracted: number; claim_unaccepted: number; outside_scope: number; external_not_selected: number };
  proofCycleRelationIds: string[];
}
