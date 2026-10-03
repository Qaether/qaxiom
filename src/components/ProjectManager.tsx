import { useEffect, useState } from 'react';
import { listResearchProjects, moveTheoryProject, renameResearchProject, selectProjectCanonical } from '../services/theory/projects';
import type { TheorySnapshot } from '../services/theory/types';

export default function ProjectManager({ snapshot, disabled, onChanged, onBusyChanged }: { snapshot: TheorySnapshot; disabled: boolean; onChanged: (value: TheorySnapshot) => Promise<void>; onBusyChanged: (busy: boolean) => void }) {
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof listResearchProjects>>>([]);
  const [name, setName] = useState(''), [targetId, setTarget] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  useEffect(() => {
    let active = true;
    void listResearchProjects().then(rows => { if (active) { setProjects(rows); setName(rows.find(p => p.id === snapshot.document.projectId)?.title ?? ''); setTarget(''); } }).catch(() => { if (active) setError('프로젝트 목록을 읽지 못했습니다.'); });
    return () => { active = false; };
  }, [snapshot.document.id, snapshot.document.projectId]);
  const project = projects.find(p => p.id === snapshot.document.projectId);
  const execute = async (action: () => Promise<void>) => {
    setBusy(true); onBusyChanged(true); setError(''); setStatus('');
    try { await action(); setProjects(await listResearchProjects()); setStatus('프로젝트 저장 완료. 문서 버전·연구 기준·검토 이력은 변경하지 않았습니다.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '프로젝트 저장 실패'); }
    finally { setBusy(false); onBusyChanged(false); }
  };
  return <section aria-label="연구 프로젝트 관리">
    <p>프로젝트는 문서를 묶는 조직 단위입니다. 대표 문서는 다른 문서의 정본/기준을 대체하지 않습니다. 아래의 허용 자료 정책은 외부 대조와 명시적으로 선택한 프로젝트 RAG·임베딩에 적용할 수 있습니다. 교차 프로젝트 Claim은 사용자 승인 후보 관계만 연결하며 의미 기반 통합·접근 제어는 아직 없습니다.</p>
    {project && <p>현재 프로젝트: {project.title} · 문서 {project.documentCount}개 · {project.canonicalDocumentId === snapshot.document.id ? '현재 문서가 대표 문서' : '다른 문서가 대표 문서'}</p>}
    <fieldset disabled={disabled || busy || !project}>
      <label>프로젝트 이름<input maxLength={200} value={name} onChange={e => setName(e.target.value)} /></label>
      <button type="button" disabled={!name.trim()} onClick={() => void execute(async () => { await renameResearchProject(project!.id, project!.title, name); })}>프로젝트 이름 저장</button>
      <label>이동할 프로젝트<select value={targetId} onChange={e => setTarget(e.target.value)}><option value="">명시 선택</option>{projects.filter(p => p.id !== snapshot.document.projectId).map(p => <option value={p.id} key={p.id}>{p.title} · 문서 {p.documentCount}개</option>)}</select></label>
      <button type="button" disabled={!targetId} onClick={() => {
        if (!window.confirm('이 문서만 선택 프로젝트로 이동할까요? 목적지의 외부 대조 자료 정책이 적용됩니다. 버전/검토/원문은 합치지 않습니다. 빈 출발 프로젝트 메타데이터만 제거하고 남은 문서에서 대표를 지정합니다.')) return;
        void execute(async () => { const target = projects.find(p => p.id === targetId); if (!target) throw new Error('도착 프로젝트를 다시 확인하세요.'); await onChanged(await moveTheoryProject(snapshot, { projectId: target.id, canonicalDocumentId: target.canonicalDocumentId })); });
      }}>선택 프로젝트로 문서 이동</button>
      <button type="button" disabled={!name.trim()} onClick={() => {
        if (!window.confirm('입력한 이름의 별도 프로젝트로 이 문서를 분리할까요? 기존 외부 대조 자료 제한을 승계합니다. 빈 출발 프로젝트 메타데이터만 제거하며 문서/버전은 삭제하지 않습니다.')) return;
        void execute(async () => { await onChanged(await moveTheoryProject(snapshot, { newTitle: name })); });
      }}>별도 프로젝트로 문서 분리</button>
      <button type="button" disabled={project?.canonicalDocumentId === snapshot.document.id} onClick={() => {
        if (!window.confirm('현재 문서를 프로젝트의 대표 문서로 지정할까요? 정본/검토 결과를 합치지 않습니다.')) return;
        void execute(async () => { await selectProjectCanonical(snapshot, project!.canonicalDocumentId); });
      }}>현재 문서를 프로젝트 대표로 지정</button>
    </fieldset>
    {busy && <p role="status">프로젝트 저장 중…</p>}{!busy && status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
