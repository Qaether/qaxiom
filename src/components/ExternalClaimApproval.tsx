import { useEffect, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { acceptExternalClaim, prepareExternalClaimAcceptance, retractExternalClaim, type ExternalClaim, type ExternalClaimPreview } from '../services/theory/externalClaims';
import type { ReviewRun } from '../services/theory/reviewTypes';
import type { TheorySnapshot } from '../services/theory/types';

export default function ExternalClaimApproval({ run, pairId, snapshot, disabled }: {
  run: ReviewRun; pairId: string; snapshot: TheorySnapshot; disabled: boolean;
}) {
  const [rows, setRows] = useState<ExternalClaim[]>([]), [preview, setPreview] = useState<{ key: string; value: ExternalClaimPreview } | null>(null);
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const candidate = run.external?.assessments.find(a => a.pairId === pairId)?.referenceClaim;
  const key = JSON.stringify([run.id, pairId, candidate, snapshot.version.id]);
  const visible = preview?.key === key ? preview.value : null;
  const refresh = async () => setRows((await qaxiomDatabase.external_claims.where('[runId+pairId]').equals([run.id, pairId]).toArray()).sort((a, b) => b.acceptedAt - a.acceptedAt));
  useEffect(() => {
    let active = true;
    void qaxiomDatabase.external_claims.where('[runId+pairId]').equals([run.id, pairId]).toArray()
      .then(found => { if (active) setRows(found.sort((a, b) => b.acceptedAt - a.acceptedAt)); })
      .catch(() => { if (active) setError('외부 주장 채택 이력을 읽지 못했습니다.'); });
    return () => { active = false; };
  }, [run.id, pairId]);
  const execute = async (task: () => Promise<void>) => {
    setBusy(true); setError(''); setStatus('');
    try { await task(); } catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : '외부 주장 채택 실패'); }
    finally { setBusy(false); }
  };
  if (!candidate) return null;
  return <section aria-label="외부 주장 후보 채택">
    <p>선택 원문에 묶인 모델 제안을 별도 채택합니다. 채택은 원문 귀속을 기록하는 사용자 결정이며 주장·실험·증명의 참이나 이론의 정합성 승인이 아닙니다.</p>
    <button type="button" disabled={disabled || busy || run.versionId !== snapshot.version.id} onClick={() => void execute(async () => {
      setPreview(null); setPreview({ key, value: await prepareExternalClaimAcceptance(run.id, pairId) });
    })}>외부 주장 채택 미리보기</button>
    {visible && <section aria-label="외부 주장 채택 미리보기">
      <p>프로젝트 {visible.projectId} · 출처 {visible.sourceName} · 페이지 {visible.page ?? '텍스트'} · 구간 {visible.spanId} · 원문 SHA-256 {visible.spanHash}</p>
      <p>주장 요약: {visible.candidate.statement} · 종류 {visible.candidate.kind} · 근거 유형 {visible.candidate.basis}</p>
      <p>원문 적용 조건: {visible.candidate.conditions}</p><blockquote>{visible.candidate.evidenceQuote}</blockquote>
      <button type="button" disabled={disabled || busy} onClick={() => {
        if (!window.confirm('선택 원문의 인용·주장 요약·조건·출처를 대조했습니까? 이 기록은 사용자 채택이며 독립성/참/정합성 증명이 아닙니다.')) return;
        void execute(async () => { await acceptExternalClaim(visible); setPreview(null); await refresh(); setStatus('외부 주장 후보를 별도 채택·저장했습니다. 정본/검토/관계 상태는 변경하지 않았습니다.'); });
      }}>이 외부 주장을 별도 채택·저장</button>
    </section>}
    {rows.map(row => <article key={row.id} aria-label="외부 주장 채택 기록">
      <p>{row.retractedAt === null ? '채택' : '철회'} · {row.claim.kind} · {row.claim.statement}</p>
      <p>출처 구간 {row.spanId} · SHA-256 {row.spanHash} · 프로젝트 {row.projectId} · 근거 유형 {row.claim.basis}</p>
      <blockquote>{row.claim.evidenceQuote}</blockquote>
      {row.retractedAt === null ? <div>
        <label>외부 주장 철회 사유<input value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} /></label>
        <button type="button" disabled={disabled || busy || !reason.trim()} onClick={() => {
          if (!window.confirm('이 외부 주장 채택을 철회할까요? 과거 기록은 유지되며 다른 검토/관계는 자동 변경하지 않습니다.')) return;
          void execute(async () => { await retractExternalClaim(row.id, reason); setReason(''); await refresh(); setStatus('외부 주장 채택을 철회했습니다. 과거 기록은 보존했습니다.'); });
        }}>외부 주장 채택 철회</button>
      </div> : <p>철회 사유: {row.retractionNote}</p>}
    </article>)}
    {run.versionId !== snapshot.version.id && <p>과거 정본 버전의 대조입니다. 새 채택 전 현재 버전을 다시 대조하세요.</p>}
    {busy && <p role="status">외부 주장 확인 중…</p>}{!busy && status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
