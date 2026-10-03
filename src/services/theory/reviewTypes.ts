export const CLAIM_KINDS = ['assumption', 'definition', 'conjecture', 'lemma', 'theorem', 'result'] as const;
export interface ResearchClaim {
  id: string;
  blockId: string;
  blockHash: string;
  statement: string;
  kind: typeof CLAIM_KINDS[number];
  acceptance: 'proposed' | 'accepted' | 'rejected';
  origin: 'heuristic' | 'model';
}
export interface ReviewIssue {
  id: string;
  kind: 'missing_contract' | 'broken_reference' | 'argument' | 'scope' | 'counterexample' | 'insufficient_evidence' | 'invalid_declaration' | 'symbol_conflict' | 'undefined_symbol' | 'proof_cycle';
  severity: 'info' | 'warning' | 'critical';
  blockIds: string[];
  quotes: string[];
  explanation: string;
  resolution: string;
  resolvedByRunId: string | null;
}
export interface TheoryPatch {
  impact?: import('./patchImpact').PatchImpact;
  id: string;
  issueIds: string[];
  blockId: string;
  beforeHash: string;
  replacement: string;
  introducedAssumptions: string;
  appliedVersionId: string | null;
}
export interface ReviewRun {
  external?: import('./externalReview').ExternalReviewResult;
  graph?: import('./reviewGraphTypes').ReviewGraphContext;
  id: string;
  documentId: string;
  versionId: string;
  versionHash: string;
  checker: 'local-v1' | 'local-v2' | 'llm-v1' | 'external-v1';
  modelId: string | null;
  createdAt: number;
  durationMs: number;
  status: 'complete' | 'stopped' | 'failed';
  outcome: 'issues' | 'scope_passed' | 'insufficient';
  checkedBlockIds: string[];
  uncheckedBlockIds: string[];
  claims: ResearchClaim[];
  issues: ReviewIssue[];
  patches: TheoryPatch[];
  error: string;
  limitations: string[];
}
export interface ReviewData { reviewRuns: ReviewRun[] }

export const isLocalChecker = (checker: ReviewRun['checker']) => checker === 'local-v1' || checker === 'local-v2';
export const checkerCovers = (before: ReviewRun['checker'], after: ReviewRun['checker']) => before === after || before === 'local-v1' && after === 'local-v2';
