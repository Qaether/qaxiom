import { useEffect, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { saveProjectSources } from '../services/theory/projectSources';
import type { ResearchProject, TheorySnapshot } from '../services/theory/types';
import type { ReferenceDocument } from '../services/retrieval/types';

export default function ProjectSources({ snapshot, disabled, onBusyChanged }: { snapshot: TheorySnapshot; disabled: boolean; onBusyChanged: (busy: boolean) => void }) {
  const [project, setProject] = useState<ResearchProject | null>(null), [sources, setSources] = useState<ReferenceDocument[]>([]);
  const [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [researchScope, setResearchScope] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      const p = await qaxiomDatabase.projects.get(snapshot.document.projectId), refs = await qaxiomDatabase.references.toArray();
      if (active) { setProject(p ?? null); setSources(refs); setSelected(p?.sourcePolicy?.allowedSourceIds ?? []); setResearchScope(p?.sourcePolicy?.scope === 'research'); setStatus(''); }
    })().catch(() => { if (active) setError('프로젝트 자료 목록을 읽지 못했습니다.'); });
    return () => { active = false; };
  }, [snapshot.document.projectId]);
  return <section aria-label="프로젝트 자료 정책">
    <p>기본 적용 범위: 독립 외부 대조 및 그 결과의 관계 승인. 아래에서 정본 선택 전후의 프로젝트 RAG와 임베딩 검색에도 적용할 수 있습니다. 프로젝트와 정본을 고르지 않은 작업공간 전체 검색·임베딩, 내부 검토에는 적용하지 않습니다. 접근 제어나 학술적 독립성의 증명이 아닙니다.</p>
    <p>{project?.sourcePolicy ? `허용 목록 적용 · 개정 ${project.sourcePolicy.revision} · ${project.sourcePolicy.allowedSourceIds.length}개` : '이전 호환 상태: 외부 대조 자료 제한 없음. 허용 목록 저장 후 새 자료는 별도 허용해야 합니다.'}</p>
    <fieldset disabled={disabled || busy || !project || project.id !== snapshot.document.projectId}>
      <label><input type="checkbox" checked={researchScope} onChange={e => setResearchScope(e.target.checked)} />프로젝트 RAG·임베딩에도 적용 (정본 선택 전후)</label>
      {sources.map(s => <label key={s.id}><input type="checkbox" aria-label={`허용 자료 ${s.name}`} checked={selected.includes(s.id)} onChange={e => setSelected(e.target.checked ? [...selected, s.id] : selected.filter(id => id !== s.id))} />{s.name} · {s.role}</label>)}
      <p>메모/자체 문서는 목록에 있어도 독립 외부 대조에 사용할 수 없습니다. 빈 목록은 외부 대조 자료 전체 차단입니다. 최대 1,000자료.</p>
      <button type="button" onClick={() => {
        if (!window.confirm(`선택 자료만 현재 프로젝트의 외부 대조${researchScope ? '와 프로젝트 RAG·임베딩 (정본 선택 전후)' : '에만'} 허용할까요? ${!researchScope && project?.sourcePolicy?.scope === 'research' ? '프로젝트 RAG·임베딩 제한은 해제됩니다. ' : ''}빈 목록은 해당 자료 전체 차단이며 기존 전송 미리보기는 다시 확인해야 합니다. 원문은 삭제하지 않습니다.`)) return;
        setBusy(true); onBusyChanged(true); setError(''); setStatus('');
        void saveProjectSources(snapshot, project?.sourcePolicy?.revision ?? null, selected, qaxiomDatabase, researchScope ? 'research' : 'external_review').then(policy => {
          setProject(p => p ? { ...p, sourcePolicy: policy } : p); setStatus(`허용 목록 저장 완료. 적용 범위: 외부 대조${policy.scope === 'research' ? ' + 프로젝트 RAG·임베딩 (정본 선택 전후)' : '만'}. 프로젝트/정본 미선택 작업공간 검색은 별도입니다.`);
        }).catch(cause => setError(cause instanceof Error ? cause.message : '자료 정책 저장 실패')).finally(() => { setBusy(false); onBusyChanged(false); });
      }}>프로젝트 허용 목록 저장</button>
    </fieldset>
    {!busy && status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
