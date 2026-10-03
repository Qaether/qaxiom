import { expect, it } from 'vitest';
import { suggestExternalClaimCandidates } from './externalClaimCandidates';
import type { ProjectExternalClaimEntry } from './externalClaims';

function entry(id: string, projectId: string, statement: string, status: ProjectExternalClaimEntry['status'] = 'current') {
  return { status, row: { id, projectId, claim: { statement } } } as ProjectExternalClaimEntry;
}

it('shows only lexical overlaps from explicitly loaded current claims in another project', () => {
  const selected = entry('a', 'p1', 'Quantum spin coupling predicts oscillation');
  const candidates = suggestExternalClaimCandidates(selected, [
    entry('same-project', 'p1', 'Quantum spin coupling'),
    entry('stale', 'p2', 'Quantum spin coupling', 'policy_changed'),
    entry('unrelated', 'p2', 'Thermal pressure decreases'),
    entry('weak', 'p2', 'spin distribution differs'),
    entry('strong', 'p2', 'Quantum spin coupling is measured')
  ]);
  expect(candidates.map(candidate => candidate.entry.row.id)).toEqual(['strong', 'weak']);
  expect(candidates[0].sharedTerms).toContain('quantum');
  expect(candidates[0].score).toBeGreaterThan(candidates[1].score);
});

it('does not imply semantic matching, approval or a fallback for an empty/old claim', () => {
  const selected = entry('a', 'p1', '파동의 회전');
  expect(suggestExternalClaimCandidates(selected, [entry('b', 'p2', 'Wave rotation')])).toEqual([]);
  expect(suggestExternalClaimCandidates({ ...selected, status: 'retracted' }, [entry('b', 'p2', '파동의 회전')])).toEqual([]);
  expect(suggestExternalClaimCandidates(selected, [entry('b', 'p2', '파동의 회전')], 0)).toEqual([]);
});
