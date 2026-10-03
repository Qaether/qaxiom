import type { TheoryData } from './types';
import type { ReviewData, ReviewRun, ResearchClaim, ReviewIssue, TheoryPatch } from './reviewTypes';
import { CLAIM_KINDS, checkerCovers, isLocalChecker } from './reviewTypes';
import { parseReviewGraph } from './reviewGraphValidation';
import { impactedBlocks } from './patchImpact';
import { parseExternalContext, parseExternalResponse } from './externalReview';
import type { ReferenceData } from '../retrieval/types';

export function parseReviewData(value: unknown, theory: TheoryData, references: ReferenceData = { references: [], referenceSpans: [] }): ReviewData {
  function fail(): never { throw new Error('검토 기록의 버전·원문·수정 참조가 올바르지 않습니다.'); }
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const string = (value: unknown): value is string => typeof value === 'string';
  const text = (value: unknown): value is string => string(value) && !!value.trim();
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
  const unique = (ids: string[]) => { if (new Set(ids).size !== ids.length) fail(); };
  if (!record(value) || !Array.isArray(value.reviewRuns)) fail();
  const reviewRuns = (value.reviewRuns as unknown[]).map(input => {
    if (!record(input) || !text(input.id) || !text(input.documentId) || !text(input.versionId) || !text(input.versionHash)
      || !['local-v1', 'local-v2', 'llm-v1', 'external-v1'].includes(String(input.checker)) || !['complete', 'stopped', 'failed'].includes(String(input.status))
      || !['issues', 'scope_passed', 'insufficient'].includes(String(input.outcome))
      || typeof input.createdAt !== 'number' || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0
      || typeof input.durationMs !== 'number' || !Number.isFinite(input.durationMs) || input.durationMs < 0
      || !strings(input.checkedBlockIds) || !strings(input.uncheckedBlockIds) || !strings(input.limitations) || !string(input.error)
      || !Array.isArray(input.claims) || input.claims.length > 200 || !Array.isArray(input.issues) || input.issues.length > 1000 || !Array.isArray(input.patches) || input.patches.length > 100) fail();
    const local = isLocalChecker(input.checker as ReviewRun['checker']);
    if (local ? input.modelId !== null : !text(input.modelId)) fail();
    const version = theory.documentVersions.find(version => version.id === input.versionId);
    if (!version || version.documentId !== input.documentId || version.contentHash !== input.versionHash) fail();
    const blocks = theory.documentBlocks.filter(block => block.versionId === version.id);
    const checked = input.checkedBlockIds as string[], unchecked = input.uncheckedBlockIds as string[];
    unique([...checked, ...unchecked]);
    if ([...checked, ...unchecked].length !== blocks.length || [...checked, ...unchecked].some(id => !blocks.some(block => block.id === id))) fail();
    const claims = (input.claims as unknown[]).map(item => {
      if (!record(item) || !text(item.id) || !text(item.blockId) || !text(item.statement) || !text(item.blockHash)
        || !CLAIM_KINDS.includes(item.kind as ResearchClaim['kind']) || !['proposed', 'accepted', 'rejected'].includes(String(item.acceptance))
        || !['heuristic', 'model'].includes(String(item.origin))) fail();
      const block = blocks.find(block => block.id === item.blockId);
      if (!block || !checked.includes(block.id) || block.contentHash !== item.blockHash || !block.text.includes(item.statement)
        || (local ? item.origin !== 'heuristic' : item.origin !== 'model')) fail();
      return { id: item.id, blockId: item.blockId, blockHash: item.blockHash, statement: item.statement,
        kind: item.kind, acceptance: item.acceptance, origin: item.origin } as ResearchClaim;
    });
    const issues = (input.issues as unknown[]).map(item => {
      if (!record(item) || !text(item.id) || !['missing_contract', 'broken_reference', 'argument', 'scope', 'counterexample', 'insufficient_evidence', 'invalid_declaration', 'symbol_conflict', 'undefined_symbol', 'proof_cycle'].includes(String(item.kind))
        || !['info', 'warning', 'critical'].includes(String(item.severity)) || !strings(item.blockIds) || !strings(item.quotes)
        || item.blockIds.length !== item.quotes.length || !text(item.explanation) || !text(item.resolution)
        || (item.resolvedByRunId !== null && !text(item.resolvedByRunId))) fail();
      const ids = item.blockIds as string[], quotes = item.quotes as string[];
      if (ids.some((id, i) => !checked.includes(id) || !quotes[i].trim() || !blocks.find(block => block.id === id)?.text.includes(quotes[i]))) fail();
      if (item.kind !== 'missing_contract' && !ids.length) fail();
      const localKinds = input.checker === 'local-v1' ? ['missing_contract', 'broken_reference'] : ['missing_contract', 'broken_reference', 'invalid_declaration', 'symbol_conflict', 'undefined_symbol', 'proof_cycle'];
      if (local ? !localKinds.includes(String(item.kind)) : !['argument', 'scope', 'counterexample', 'insufficient_evidence'].includes(String(item.kind))) fail();
      return { id: item.id, kind: item.kind, severity: item.severity, blockIds: ids, quotes, explanation: item.explanation, resolution: item.resolution, resolvedByRunId: item.resolvedByRunId } as ReviewIssue;
    });
    const patches = (input.patches as unknown[]).map(item => {
      if (!record(item) || !text(item.id) || !strings(item.issueIds) || !item.issueIds.length || !text(item.blockId) || !text(item.beforeHash)
        || !text(item.replacement) || !string(item.introducedAssumptions) || (item.appliedVersionId !== null && !text(item.appliedVersionId)) || input.checker !== 'llm-v1') fail();
      const block = blocks.find(block => block.id === item.blockId);
      if (!block || block.contentHash !== item.beforeHash || !checked.includes(block.id) || block.text === item.replacement
        || (item.issueIds as string[]).some(id => !issues.some(issue => issue.id === id && issue.blockIds.includes(block.id)))) fail();
      if (item.appliedVersionId !== null) {
        const applied = theory.documentVersions.find(version => version.id === item.appliedVersionId);
        const expected = version.markdown.slice(0, block.startOffset) + item.replacement + version.markdown.slice(block.endOffset);
        const expectedAssumptions = version.contract.assumptions + (item.introducedAssumptions.trim() ? `${version.contract.assumptions ? '\n\n' : ''}[승인한 수정의 새 가정]\n${item.introducedAssumptions}` : '');
        if (!applied || applied.parentVersionId !== version.id || applied.documentId !== version.documentId || applied.markdown !== expected
          || applied.contract.assumptions !== expectedAssumptions || applied.title !== version.title
          || Object.keys(version.contract).some(key => key !== 'assumptions' && applied.contract[key as keyof typeof version.contract] !== version.contract[key as keyof typeof version.contract])) fail();
      }
      return { id: item.id, issueIds: item.issueIds, blockId: item.blockId, beforeHash: item.beforeHash, replacement: item.replacement,
        ...(item.impact !== undefined ? { impact: structuredClone(item.impact) } : {}),
        introducedAssumptions: item.introducedAssumptions, appliedVersionId: item.appliedVersionId } as TheoryPatch;
    });
    unique(claims.map(item => item.id)); unique(issues.map(item => item.id)); unique(patches.map(item => item.id));
    if (input.status !== 'complete' && (input.outcome !== 'insufficient' || claims.length || issues.length || patches.length || checked.length)) fail();
    if (input.status === 'complete') {
      const expectedOutcome = input.checker === 'external-v1' ? 'insufficient' : issues.length ? 'issues' : input.checker === 'llm-v1' && (unchecked.length || (input.limitations as string[]).length) ? 'insufficient' : 'scope_passed';
      if (input.outcome !== expectedOutcome) fail();
    }
    return { id: input.id, documentId: input.documentId, versionId: input.versionId, versionHash: input.versionHash,
      ...(input.graph !== undefined ? { graph: structuredClone(input.graph) } : {}),
      ...(input.external !== undefined ? { external: structuredClone(input.external) } : {}),
      checker: input.checker, modelId: input.modelId, createdAt: input.createdAt, durationMs: input.durationMs, status: input.status, outcome: input.outcome,
      checkedBlockIds: checked, uncheckedBlockIds: unchecked, claims, issues, patches, error: input.error, limitations: input.limitations } as ReviewRun;
  });
  unique(reviewRuns.map(run => run.id));
  for (const run of reviewRuns) {
    if (run.checker === 'external-v1') {
      if (!record(run.external) || run.graph || run.checkedBlockIds.length || run.claims.length || run.issues.length || run.patches.length || run.outcome !== 'insufficient') fail();
      const context = parseExternalContext(run.external.context, theory, references);
      if (context.versionId !== run.versionId) fail();
      const result = parseExternalResponse(JSON.stringify({ ...run.external, limitations: run.limitations }), context);
      if (run.status !== 'complete' && result.checkedPairIds.length) fail();
      run.external = { context, checkedPairIds: result.checkedPairIds, assessments: result.assessments };
    } else if (run.external) fail();
  }
  for (const run of reviewRuns) for (const patch of run.patches) if (patch.impact !== undefined) {
    const impact = patch.impact;
    if (!patch.appliedVersionId || !record(impact) || impact.version !== 1 || typeof impact.patchHash !== 'string' || !/^[a-f0-9]{64}$/.test(impact.patchHash) || typeof impact.contractChanged !== 'boolean'
      || impact.contractChanged !== !!patch.introducedAssumptions.trim()) fail();
    const graph = parseReviewGraph(impact.graph, run.versionId, theory, { reviewRuns });
    const affected = impactedBlocks(patch.blockId, graph.relationSnapshots);
    const targets = theory.documentBlocks.filter(b => b.versionId === run.versionId && (impact.contractChanged || affected.has(b.id)))
      .sort((a, b) => a.position - b.position).map(b => b.id);
    if (JSON.stringify(targets) !== JSON.stringify(graph.targetBlockIds)) fail();
    patch.impact = { version: 1, graph, contractChanged: impact.contractChanged, patchHash: impact.patchHash };
  }
  for (const run of reviewRuns) if (run.graph !== undefined) {
    if (run.checker !== 'llm-v1') fail();
    run.graph = parseReviewGraph(run.graph, run.versionId, theory, { reviewRuns });
    if (run.status === 'complete' && run.graph.proofCycleRelationIds.length && !run.limitations.length) fail();
    const included = [...run.graph.targetBlockIds, ...run.graph.premiseBlockIds];
    if (run.checkedBlockIds.some(id => !included.includes(id)) || run.graph.relationSnapshots.some(r => r.from.runId === run.id || r.to.type === 'claim' && r.to.runId === run.id)) fail();
  }
  for (const run of reviewRuns) for (const issue of run.issues) if (issue.resolvedByRunId) {
    const recheck = reviewRuns.find(recheck => recheck.id === issue.resolvedByRunId);
    if (!recheck || !checkerCovers(run.checker, recheck.checker) || recheck.documentId !== run.documentId || recheck.status !== 'complete'
      || recheck.outcome !== 'scope_passed' || recheck.uncheckedBlockIds.length || recheck.versionId === run.versionId) fail();
    let version = theory.documentVersions.find(version => version.id === recheck.versionId);
    while (version?.parentVersionId && version.parentVersionId !== run.versionId) version = theory.documentVersions.find(next => next.id === version?.parentVersionId);
    if (version?.parentVersionId !== run.versionId) fail();
  }
  return { reviewRuns };
}
