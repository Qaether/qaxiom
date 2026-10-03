import { useEffect, useState } from 'react';
import { loadProjectExternalClaims, type ProjectExternalClaimEntry, type ProjectExternalClaimStatus } from '../services/theory/externalClaims';
import type { TheorySnapshot } from '../services/theory/types';
import ReferenceSource from './ReferenceSource';
import ExternalClaimConnections from './ExternalClaimConnections';

const labels: Record<ProjectExternalClaimStatus, string> = {
  current: '현재 범위에서 유효한 채택 기록',
  retracted: '철회된 기록',
  document_moved: '문서가 다른 프로젝트로 이동',
  version_stale: '과거 정본 버전',
  policy_changed: '프로젝트 허용 정책 변경',
  source_changed: '원문·역할 변경'
};

export default function ProjectExternalClaims({ snapshot }: { snapshot: TheorySnapshot }) {
  const projectId = snapshot.document.projectId;
  const [entries, setEntries] = useState<ProjectExternalClaimEntry[]>([]), [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'current' | 'history'>('all');
  const [opened, setOpened] = useState<ProjectExternalClaimEntry | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const refresh = async () => { setBusy(true); setError(''); try { setEntries(await loadProjectExternalClaims(projectId)); }
    catch (cause) { setEntries([]); setError(cause instanceof Error ? cause.message : '외부 주장 원장을 읽지 못했습니다.'); }
    finally { setBusy(false); } };
  useEffect(() => {
    let active = true;
    void loadProjectExternalClaims(projectId).then(rows => { if (active) setEntries(rows); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '외부 주장 원장을 읽지 못했습니다.'); });
    return () => { active = false; };
  }, [projectId]);
  const terms = query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const visible = entries.filter(entry => (scope === 'all' || scope === 'current' && entry.status === 'current' || scope === 'history' && entry.status !== 'current')
    && terms.every(term => [entry.row.claim.statement, entry.row.claim.evidenceQuote, entry.row.claim.conditions, entry.sourceName, entry.documentTitle]
      .some(value => value.normalize('NFKC').toLowerCase().includes(term))));
  return <section aria-label="프로젝트 외부 주장 원장">
    <h3>프로젝트 외부 주장 원장</h3>
    <p>이 프로젝트에서 별도로 채택한 외부 주장만 로컬 탐색합니다. 현재 범위/과거 버전·정책 변경/철회를 구분하며 다른 프로젝트의 채택을 섞지 않습니다. 원장과 검색 결과는 주장의 참, 논리적 지지·상충 또는 이론 정합성 판정이 아닙니다.</p>
    <p>기록 {entries.length}개 · 현재 범위 {entries.filter(e => e.status === 'current').length}개 · 이력/철회 {entries.filter(e => e.status !== 'current').length}개</p>
    <button type="button" disabled={busy} onClick={() => void refresh()}>프로젝트 외부 주장 새로고침</button>
    <label>외부 주장 원장 검색<input value={query} onChange={e => setQuery(e.target.value)} placeholder="주장·조건·원문·문서명" /></label>
    <label>외부 주장 상태<select value={scope} onChange={e => setScope(e.target.value as typeof scope)}><option value="all">전체 기록</option><option value="current">현재 범위</option><option value="history">이력·철회</option></select></label>
    <p>표시 {visible.length}/{entries.length}개 · 검색은 표시된 필드의 문자열 포함 검사이며 의미 검색이나 누락 없음의 증명이 아닙니다.</p>
    {visible.map(entry => <article key={entry.row.id} aria-label="프로젝트 외부 주장 기록">
      <p>{labels[entry.status]} · {entry.documentTitle} · {entry.sourceName}</p>
      <p>{entry.row.claim.kind} · 근거 유형 {entry.row.claim.basis} · 프로젝트 {entry.row.projectId} · 대조 {entry.row.runId}</p>
      <p>주장: {entry.row.claim.statement}</p><p>적용 조건: {entry.row.claim.conditions}</p>
      <blockquote>{entry.row.claim.evidenceQuote}</blockquote>
      {entry.status === 'retracted' && <p>철회 사유: {entry.row.retractionNote}</p>}
      <button type="button" onClick={() => setOpened(entry)}>출처 원문 확인: {entry.sourceName}</button>
    </article>)}
    {busy && <p role="status">프로젝트 원장 확인 중…</p>}{error && <p role="alert">{error}</p>}
    <ExternalClaimConnections projectId={projectId} local={entries} />
    {opened && <ReferenceSource evidence={opened.evidence} onClose={() => setOpened(null)} />}
  </section>;
}
