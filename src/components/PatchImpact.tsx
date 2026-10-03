import { useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { currentPatchImpactScope, patchContentHash, preparePatchImpact, type PatchImpact as Impact } from '../services/theory/patchImpact';
import type { ReviewRun, TheoryPatch } from '../services/theory/reviewTypes';
import { checkerCovers } from '../services/theory/reviewTypes';
import type { DocumentBlock, TheorySnapshot } from '../services/theory/types';
import { prepareUndeclaredImpact, rankImpactInWorker, selectUndeclaredImpact, type UndeclaredImpact } from '../services/theory/undeclaredImpact';

export default function PatchImpact({ run, patch, snapshot, runs, disabled, onApply, onSelect }: {
  run: ReviewRun; patch: TheoryPatch; snapshot: TheorySnapshot; runs: ReviewRun[]; disabled: boolean;
  onApply: (impact: Impact) => void; onSelect: (blockIds: string[]) => void;
}) {
  const [preview, setPreview] = useState<{ impact: Impact; blocks: DocumentBlock[] } | null>(null);
  const [scope, setScope] = useState<Awaited<ReturnType<typeof currentPatchImpactScope>> | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [candidates, setCandidates] = useState<UndeclaredImpact | null>(null);
  const [chosen, setChosen] = useState<string[]>([]), [nominated, setNominated] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const impact = patch.impact ?? preview?.impact;
  const inspect = async () => {
    setBusy(true); setError(''); setPreview(null);
    try {
      const value = patch.appliedVersionId ? patch.impact : (await preparePatchImpact(run.id, patch.id)).impact;
      if (!value) throw new Error('이전 형식 수정에는 영향 이력이 없습니다. 전체 문서를 재검사하세요.');
      if (await patchContentHash(run, patch) !== value.patchHash) throw new Error('수정 diff가 변경되었습니다. 최신 제안을 다시 확인하세요.');
      const ids = [...value.graph.targetBlockIds, ...value.graph.premiseBlockIds];
      const blocks = await qaxiomDatabase.document_blocks.where('versionId').equals(run.versionId).sortBy('position');
      setPreview({ impact: value, blocks: blocks.filter(b => ids.includes(b.id)) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : '영향 범위 확인 실패'); }
    finally { setBusy(false); }
  };
  const select = async () => {
    setBusy(true); setError(''); setScope(null); setCandidates(null); setChosen([]); setNominated([]);
    try { const value = await currentPatchImpactScope(run.id, patch.id, snapshot); setScope(value); onSelect(value.blockIds); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '재검사 범위 선택 실패'); }
    finally { setBusy(false); }
  };
  const checked = new Set(runs.filter(r => r.versionId === snapshot.version.id && r.status === 'complete' && checkerCovers(run.checker, r.checker)).flatMap(r => r.checkedBlockIds));
  const currentCandidates = candidates?.versionId === snapshot.version.id ? candidates : null;
  const searchCandidates = async () => {
    setBusy(true); setSearching(true); setError(''); setCandidates(null); setChosen([]); setNominated([]);
    const abort = new AbortController(); controller.current = abort;
    try {
      const result = await prepareUndeclaredImpact(run.id, patch.id, snapshot, qaxiomDatabase, input => rankImpactInWorker(input, abort.signal));
      abort.signal.throwIfAborted(); setCandidates(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '미선언 영향 후보 검색 실패'); }
    finally { setBusy(false); setSearching(false); controller.current = null; }
  };
  const nominate = async () => {
    if (!currentCandidates) return;
    setBusy(true); setError(''); setNominated([]);
    try {
      const ids = await selectUndeclaredImpact(run.id, patch.id, snapshot, currentCandidates, chosen);
      setScope(null); setNominated(ids); onSelect(ids);
    } catch (cause) { setCandidates(null); setChosen([]); setError(cause instanceof Error ? cause.message : '후보 범위 선택 실패'); }
    finally { setBusy(false); }
  };
  return <section aria-label="수정 영향 범위">
    <p>승인 관계에 선언된 영향 후보이며 미선언 관계의 완전성은 미확인입니다. 과거 승인을 새 버전의 활성 관계로 옮기지 않습니다.</p>
    <button type="button" disabled={disabled || busy || !patch.appliedVersionId && run.versionId !== snapshot.version.id} onClick={() => void inspect()}>수정 영향 범위 확인</button>
    {impact && <p>적용 전 목표 {impact.graph.targetBlockIds.length}블록 · 추가 전제 {impact.graph.premiseBlockIds.length}블록 · 관계 {impact.graph.relationSnapshots.length}개 · {impact.contractChanged ? '새 가정 — 전체 문서 재검사 후보' : '승인 의존·정의 역참조 및 지지·충돌 연결 후보'} · 외부 자료 미전송 {impact.graph.excludedCounts.external_not_selected}개</p>}
    {preview && <details open><summary>영향 후보 원문과 적용 전 승인 이력</summary>
      {preview.blocks.map(b => <div key={b.id}><p>{preview.impact.graph.targetBlockIds.includes(b.id) ? '영향 목표' : '필수 전제'} · 블록 {b.position + 1} · {b.id} · {b.contentHash}</p><pre>{b.text}</pre></div>)}
      <pre>{JSON.stringify(preview.impact, null, 2)}</pre>
    </details>}
    {!patch.appliedVersionId && <button type="button" disabled={disabled || busy || !preview || run.versionId !== snapshot.version.id} onClick={() => {
      if (!preview || !window.confirm('수정 diff·새 가정·영향 범위를 확인했습니까? 새 버전을 만들며 Issue 해결은 재검사 후 별도로 확인합니다.')) return;
      onApply(preview.impact);
    }}>수정 diff 승인 · 새 버전 저장</button>}
    {patch.appliedVersionId && <p>{patch.issueIds.every(id => run.issues.find(i => i.id === id)?.resolvedByRunId) ? '적용됨 — 사용자 해결 확인' : '적용됨 — 재검사 결과 확인 필요'} · {patch.appliedVersionId}</p>}
    {patch.appliedVersionId && patch.impact && <button type="button" disabled={disabled || busy} onClick={() => void select()}>현재 버전의 수정 영향 재검사 범위 선택</button>}
    {scope && scope.versionId === snapshot.version.id && <p>현재 버전 재검사 후보 {scope.blockIds.length}블록 · 실제 검사 {scope.blockIds.filter(id => checked.has(id)).length}/{scope.blockIds.length}. {scope.fullScope && '기준 변경/계보 누락으로 전체 범위 선택.'} 범위 선택은 전송이나 완료가 아닙니다. 과거 그래프는 요청에 첨부하지 않으며 새 원문을 미리보고 승인하세요. Issue 해결에는 기존 전체 범위 재검사 조건이 계속 적용됩니다.</p>}
    {patch.appliedVersionId && patch.impact && <section aria-label="미선언 수정 영향 후보">
      <p>수정 전후 용어·기호를 공유하지만 승인 영향 범위 밖인 블록을 로컬에서 찾습니다. NFKC 소문자·한글 2글자 어휘 일치이며 의미 의존성/수식 동치 검사가 아닙니다. 후보가 없어도 영향 없음이나 정합성이 입증되지 않습니다.</p>
      <button type="button" disabled={disabled || busy} onClick={() => void searchCandidates()}>미선언 수정 영향 후보 찾기</button>
      {searching && <button type="button" onClick={() => controller.current?.abort()}>수정 후보 검색 취소</button>}
      {currentCandidates && <>
        <p>기존 범위 {currentCandidates.scopeBlockIds.length}블록 · 범위 밖 탐색 {currentCandidates.ranking.scannedBlockCount}블록 · 표시 후보 {currentCandidates.ranking.matches.length}개 · 추가 일치 후보 미표시 {currentCandidates.ranking.omittedMatchCount}개. 최대 24개 표시하며 미표시·미일치 원문은 자동 전송하지 않습니다. 전체 범위가 필요하면 검토 목록에서 직접 선택하세요.</p>
        <details><summary>수정 전후 검색 용어</summary><pre>{JSON.stringify(currentCandidates.ranking.terms, null, 2)}</pre></details>
        {currentCandidates.ranking.matches.map(match => {
          const block = snapshot.blocks.find(b => b.id === match.blockId)!;
          return <div key={block.id}><label><input type="checkbox" aria-label={`미선언 후보 블록 ${block.position + 1}`} disabled={disabled || busy} checked={chosen.includes(block.id)} onChange={e => { setNominated([]); setChosen(e.target.checked ? [...chosen, block.id] : chosen.filter(id => id !== block.id)); }} />블록 {block.position + 1} · {block.id}</label>
            <p>제거 용어 일치: {match.removed.join(', ') || '없음'} · 추가 용어 일치: {match.added.join(', ') || '없음'} · 유지 용어 일치: {match.retained.join(', ') || '없음'}</p><pre>{block.text}</pre></div>;
        })}
        <button type="button" disabled={disabled || busy || !chosen.length} onClick={() => void nominate()}>선택 후보와 기존 영향 범위를 재검사 대상으로 지정</button>
        {!!nominated.length && <p>명시 지정 {nominated.length}블록 · 실제 검사 {nominated.filter(id => checked.has(id)).length}/{nominated.length}. 현재 승인 전제도 범위에 포함합니다. 자동 관계 승인·API 전송·Issue 해결 없음. 새 전송 미리보기를 확인하세요. 후보 검색/선택은 임시 상태이며 reload 후 다시 수행합니다.</p>}
      </>}
    </section>}
    {busy && <p role="status">영향 범위 확인 중…</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
