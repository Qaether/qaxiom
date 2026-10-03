import { useState } from 'react';
import { prepareExternalRelation, approveExternalRelation, type ExternalRelationPreview } from '../services/theory/externalRelation';
import { COMPATIBILITY_LABELS, type CompatibilityAssessment } from '../services/theory/relationTypes';
import type { ReviewRun } from '../services/theory/reviewTypes';
import type { TheorySnapshot } from '../services/theory/types';

export default function ExternalRelationApproval({ run, pairId, snapshot, runs, disabled, onChanged }: {
  run: ReviewRun; pairId: string; snapshot: TheorySnapshot; runs: ReviewRun[]; disabled: boolean; onChanged: () => Promise<void>;
}) {
  const [claimKey, setClaim] = useState(''), [kind, setKind] = useState(''), [label, setLabel] = useState('');
  const [theoryConditions, setTheoryConditions] = useState(''), [referenceConditions, setReferenceConditions] = useState(''), [note, setNote] = useState('');
  const [preview, setPreview] = useState<{ key: string; value: ExternalRelationPreview } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const pair = run.external!.context.pairs.find(p => p.id === pairId)!;
  const assessment = run.external!.assessments.find(a => a.pairId === pairId)!;
  const claims = runs.filter(r => r.status === 'complete' && r.versionId === snapshot.version.id).flatMap(r => r.claims.filter(c => c.acceptance === 'accepted' && c.blockId === pair.blockId && c.statement.includes(assessment.theoryQuote)).map(c => ({ run: r, claim: c, key: JSON.stringify([r.id, c.id]) })));
  const key = JSON.stringify([snapshot.version.id, claimKey, kind, label, theoryConditions, referenceConditions, note]);
  const visible = preview?.key === key ? preview.value : null;
  const execute = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setStatus('');
    try { await action(); } catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : '외부 대조 관계 승인 실패'); }
    finally { setBusy(false); }
  };
  return <section aria-label="외부 대조 관계 승인">
    <p>모델 제안과 별개로 현재 채택 주장·원문·조건을 확인해 관계를 승인합니다. 대조 인용을 포함하는 채택 주장이 없으면 먼저 주장 후보를 채택하세요. 외부 Claim 자동 추출이나 내부 정합성 통과가 아닙니다.</p>
    <fieldset disabled={disabled || busy || run.versionId !== snapshot.version.id}>
      <label>대조 결과와 연결할 채택 주장<select aria-label="대조 결과와 연결할 채택 주장" value={claimKey} onChange={e => setClaim(e.target.value)}><option value="">명시 선택</option>{claims.map(c => <option key={c.key} value={c.key}>{c.claim.statement}</option>)}</select></label>
      <label>대조 관계 종류<select value={kind} onChange={e => setKind(e.target.value)}><option value="">명시 선택</option><option value="supports">지지 후보</option><option value="contradicts">상충 후보</option></select></label>
      <label>대조 사용자 판단<select value={label} onChange={e => setLabel(e.target.value)}><option value="">모델 분류와 별도로 선택</option>{COMPATIBILITY_LABELS.map(l => <option key={l}>{l}</option>)}</select></label>
      <label>승인할 이론 조건<textarea value={theoryConditions} maxLength={2000} onChange={e => setTheoryConditions(e.target.value)} /></label>
      <label>승인할 원문 조건<textarea value={referenceConditions} maxLength={2000} onChange={e => setReferenceConditions(e.target.value)} /></label>
      <label>대조 관계 승인 사유<textarea value={note} maxLength={2000} onChange={e => setNote(e.target.value)} /></label>
      <button type="button" disabled={!claimKey || !kind || !label || !theoryConditions.trim() || !referenceConditions.trim() || !note.trim()} onClick={() => void execute(async () => {
        setPreview(null); const claim = claims.find(c => c.key === claimKey);
        if (!claim) throw new Error('채택 주장이 변경되었습니다. 다시 선택하세요.');
        const value = await prepareExternalRelation(run.id, pairId, { claimRunId: claim.run.id, claimId: claim.claim.id, kind: kind as 'supports' | 'contradicts', label: label as CompatibilityAssessment['label'], theoryConditions, referenceConditions, note });
        setPreview({ key, value });
      })}>대조 관계 승인 미리보기</button>
      {visible && <section aria-label="대조 관계 승인 미리보기"><p>원문: {visible.sourceName} · 모델 제안: {visible.assessment.label} · 사용자 판단: {visible.proposal.assessment!.label}</p>
        <pre>{visible.proposal.from.quote}</pre><pre>{visible.proposal.to.quote}</pre><pre>{JSON.stringify(visible.proposal, null, 2)}</pre>
        <button type="button" onClick={() => {
          if (!window.confirm('현재 채택 주장·양쪽 원문·조건·관계 종류를 확인했습니까? 모델 결과와 별도로 사용자 승인 관계를 저장하며 증명/Issue 해결은 아닙니다.')) return;
          void execute(async () => { await approveExternalRelation(visible); setPreview(null); setStatus('외부 대조 계보를 포함한 사용자 관계를 승인·저장했습니다. 내부 검사/Issue 해결 상태는 바꾸지 않았습니다.'); await onChanged(); });
        }}>이 대조 관계를 별도 승인·저장</button>
      </section>}
    </fieldset>
    {run.versionId !== snapshot.version.id && <p>이전 버전 대조 — 현재 원문 재대조 필요</p>}
    {busy && <p role="status">대조 관계 확인 중…</p>}{!busy && status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
