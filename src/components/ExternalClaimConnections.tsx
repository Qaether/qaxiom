import { useEffect, useMemo, useState } from 'react';
import { listResearchProjects } from '../services/theory/projects';
import { loadProjectExternalClaims, type ProjectExternalClaimEntry } from '../services/theory/externalClaims';
import { approveExternalClaimLink, EXTERNAL_LINK_KINDS, loadExternalClaimLinks, prepareExternalClaimLink, retractExternalClaimLink,
  type ExternalClaimLink, type ExternalClaimLinkInput, type ExternalClaimLinkPreview } from '../services/theory/externalClaimLinks';
import { suggestExternalClaimCandidates } from '../services/theory/externalClaimCandidates';
import ReferenceSource from './ReferenceSource';

const kindLabels: Record<ExternalClaimLink['kind'], string> = {
  same_concept_candidate: '같은 개념 후보', different_scope_candidate: '적용 범위 차이 후보',
  conflict_candidate: '상충 후보', related: '관련 주장'
};

export default function ExternalClaimConnections({ projectId, local }: { projectId: string; local: ProjectExternalClaimEntry[] }) {
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof listResearchProjects>>>([]);
  const [targetId, setTargetId] = useState(''), [target, setTarget] = useState<ProjectExternalClaimEntry[]>([]);
  const [fromId, setFromId] = useState(''), [toId, setToId] = useState(''), [kind, setKind] = useState<ExternalClaimLink['kind']>('related');
  const [fromConditions, setFromConditions] = useState(''), [toConditions, setToConditions] = useState(''), [note, setNote] = useState('');
  const [links, setLinks] = useState<Awaited<ReturnType<typeof loadExternalClaimLinks>>>([]);
  const [preview, setPreview] = useState<{ key: string; value: ExternalClaimLinkPreview } | null>(null);
  const [fromChecked, setFromChecked] = useState(false), [toChecked, setToChecked] = useState(false);
  const [opened, setOpened] = useState<ProjectExternalClaimEntry | null>(null), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all([listResearchProjects(), loadExternalClaimLinks(projectId)]).then(([available, rows]) => {
      if (active) { setProjects(available.filter(p => p.id !== projectId)); setLinks(rows); }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '교차 프로젝트 관계를 읽지 못했습니다.'); });
    return () => { active = false; };
  }, [projectId]);
  const execute = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setStatus('');
    try { await action(); } catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : '교차 프로젝트 관계 작업 실패'); }
    finally { setBusy(false); }
  };
  const input: ExternalClaimLinkInput = { fromProjectId: projectId, toProjectId: targetId, fromClaimId: fromId, toClaimId: toId,
    kind, fromConditions, toConditions, note };
  const key = JSON.stringify(input);
  const visible = preview?.key === key ? preview.value : null;
  const localCurrent = local.filter(entry => entry.status === 'current');
  const candidates = useMemo(() => {
    const selected = local.find(entry => entry.row.id === fromId && entry.status === 'current');
    return selected ? suggestExternalClaimCandidates(selected, target) : [];
  }, [local, fromId, target]);
  return <section aria-label="교차 프로젝트 외부 주장 연결">
    <h4>교차 프로젝트 외부 주장 연결</h4>
    <p>다른 프로젝트의 현재 채택 주장을 명시적으로 불러와 비교합니다. 비교·연결은 로컬에서만 수행하며 후보 관계를 자동 근거, 개념 동치 확정, 내부 검사 통과로 승격하지 않습니다.</p>
    <button type="button" disabled={busy} onClick={() => void execute(async () => { setLinks(await loadExternalClaimLinks(projectId)); setStatus('관계 이력을 새로 읽었습니다.'); })}>교차 프로젝트 관계 새로고침</button>
    <label>비교할 다른 프로젝트<select value={targetId} onChange={e => { setTargetId(e.target.value); setTarget([]); setToId(''); setPreview(null); }}>
      <option value="">명시 선택</option>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
    </select></label>
    <button type="button" disabled={!targetId || busy} onClick={() => void execute(async () => {
      setTarget((await loadProjectExternalClaims(targetId)).filter(entry => entry.status === 'current')); setToId(''); setPreview(null);
      setStatus('선택한 다른 프로젝트의 현재 채택 주장만 로컬에서 읽었습니다.');
    })}>선택 프로젝트 주장 불러오기</button>
    <p>현재 프로젝트 {localCurrent.length}개 · 선택 프로젝트에서 불러온 현재 주장 {target.length}개</p>
    <fieldset disabled={busy || !targetId || !target.length || !localCurrent.length}>
      <legend>양쪽 주장·조건을 명시 선택</legend>
      <label>현재 프로젝트 주장<select value={fromId} onChange={e => { setFromId(e.target.value); setPreview(null); }}><option value="">선택</option>{localCurrent.map(entry => <option key={entry.row.id} value={entry.row.id}>{entry.row.claim.statement}</option>)}</select></label>
      <label>다른 프로젝트 주장<select value={toId} onChange={e => { setToId(e.target.value); setPreview(null); }}><option value="">선택</option>{target.map(entry => <option key={entry.row.id} value={entry.row.id}>{entry.row.claim.statement}</option>)}</select></label>
      {!!fromId && <section aria-label="어휘 일치 주장 후보">
        <p>상대 프로젝트의 어휘 일치 후보 표시 {candidates.length}개(최대 12개). 주장 문장의 BM25 점수와 공통 용어만 사용합니다. 한국어 표현 차이·번역·수식 동치·상충을 판정하지 않으며, 목록 밖 주장은 위에서 직접 선택할 수 있습니다.</p>
        {candidates.map(candidate => <button key={candidate.entry.row.id} type="button" onClick={() => { setToId(candidate.entry.row.id); setPreview(null); }}>
          후보 선택: {candidate.entry.row.claim.statement} · 일치 용어 {candidate.sharedTerms.join(', ')} · 어휘 점수 {candidate.score.toFixed(3)}
        </button>)}
      </section>}
      <label>관계 후보 종류<select value={kind} onChange={e => { setKind(e.target.value as ExternalClaimLink['kind']); setPreview(null); }}>{EXTERNAL_LINK_KINDS.map(value => <option key={value} value={value}>{kindLabels[value]}</option>)}</select></label>
      <label>현재 프로젝트 주장 적용 조건<textarea value={fromConditions} maxLength={2000} onChange={e => { setFromConditions(e.target.value); setPreview(null); }} /></label>
      <label>다른 프로젝트 주장 적용 조건<textarea value={toConditions} maxLength={2000} onChange={e => { setToConditions(e.target.value); setPreview(null); }} /></label>
      <label>사용자 판단 사유<textarea value={note} maxLength={2000} onChange={e => { setNote(e.target.value); setPreview(null); }} /></label>
      <button type="button" disabled={!fromId || !toId || !fromConditions.trim() || !toConditions.trim() || !note.trim()} onClick={() => void execute(async () => {
        setPreview(null); setFromChecked(false); setToChecked(false);
        setPreview({ key, value: await prepareExternalClaimLink(input) });
      })}>교차 프로젝트 관계 미리보기</button>
    </fieldset>
    {visible && <section aria-label="교차 프로젝트 관계 승인 미리보기">
      <p>{kindLabels[visible.input.kind]} · 두 프로젝트/원문·조건을 비교하는 사용자 후보 판단입니다. 의미적 동치·모순 증명이 아닙니다.</p>
      {[visible.from, visible.to].map((entry, index) => <div key={entry.row.id}>
        <p>{index ? '다른' : '현재'} 프로젝트 {entry.row.projectId} · {entry.sourceName} · {entry.documentTitle}</p>
        <p>주장: {entry.row.claim.statement}</p><p>조건: {index ? visible.input.toConditions : visible.input.fromConditions}</p>
        <blockquote>{entry.row.claim.evidenceQuote}</blockquote>
        <button type="button" onClick={() => setOpened(entry)}>원문 확인 {index + 1}: {entry.sourceName}</button>
      </div>)}
      <p>사용자 판단 사유: {visible.input.note}</p>
      <label><input type="checkbox" checked={fromChecked} onChange={e => setFromChecked(e.target.checked)} />현재 프로젝트 원문·조건 확인</label>
      <label><input type="checkbox" checked={toChecked} onChange={e => setToChecked(e.target.checked)} />다른 프로젝트 원문·조건 확인</label>
      <button type="button" disabled={busy || !fromChecked || !toChecked} onClick={() => {
        if (!window.confirm('양쪽 원문·적용 조건을 확인했습니까? 이 연결은 사용자 판단 후보이며 RAG 근거나 정합성 통과로 자동 사용되지 않습니다.')) return;
        void execute(async () => { await approveExternalClaimLink(visible); setPreview(null); setLinks(await loadExternalClaimLinks(projectId)); setStatus('교차 프로젝트 후보 관계를 별도 승인·저장했습니다.'); });
      }}>이 후보 관계를 별도 승인·저장</button>
    </section>}
    <p>저장된 교차 프로젝트 관계 {links.length}개 · 현재 범위 {links.filter(link => link.status === 'current').length}개</p>
    {links.map(link => <article key={link.row.id} aria-label="교차 프로젝트 관계 기록">
      <p>{link.status} · {kindLabels[link.row.kind]} · 프로젝트 {link.row.fromProjectId} ↔ {link.row.toProjectId}</p>
      <p>{link.from.claim.statement} / {link.to.claim.statement}</p>
      <p>양쪽 조건: {link.row.fromConditions} / {link.row.toConditions}</p><p>판단 사유: {link.row.note}</p>
      {link.status === 'retracted' ? <p>철회 사유: {link.row.retractionNote}</p> : <div>
        <label>관계 철회 사유<input value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} /></label>
        <button type="button" disabled={busy || !reason.trim()} onClick={() => {
          if (!window.confirm('이 교차 프로젝트 후보 관계를 철회할까요? 과거 기록은 보존됩니다.')) return;
          void execute(async () => { await retractExternalClaimLink(link.row.id, reason); setReason(''); setLinks(await loadExternalClaimLinks(projectId)); setStatus('관계 철회 이력을 저장했습니다.'); });
        }}>교차 프로젝트 관계 철회</button>
      </div>}
    </article>)}
    {busy && <p role="status">교차 프로젝트 관계 확인 중…</p>}{!busy && status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
    {opened && <ReferenceSource evidence={opened.evidence} onClose={() => setOpened(null)} />}
  </section>;
}
