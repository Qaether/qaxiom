import { lazy, Suspense, useEffect, useState } from 'react';
import type { TheorySnapshot } from '../services/theory/types';
import { approveRelation, claimAnchor, loadRelationWiki, retractRelation, type RelationProposal } from '../services/theory/relations';
import { COMPATIBILITY_LABELS, RELATION_KINDS, anchorKey, type ResearchRelation } from '../services/theory/relationTypes';
import { relationGraph } from '../services/theory/relationGraph';
import { createContextBundle } from '../services/retrieval/context';
import { spanLocation } from '../services/retrieval/pdfTypes';
import type { ContextEvidence } from '../services/retrieval/types';
import { relationWikiToMarkdown } from '../services/theory/relationReport';
import { qaxiomDatabase } from '../services/database';
import { hashText } from '../services/theory/blocks';

const ReferenceSource = lazy(() => import('./ReferenceSource'));
const kindLabels = { depends_on: '의존', defines: '정의 연결', supports: '지지 후보', contradicts: '상충 후보' };
const statusLabels = { active: '현재 승인 관계', stale: '오래된 버전 — 재확인 필요', retracted: '사용자 철회', claim_unaccepted: '주장 채택 철회/미채택 — 사용 제외' };

export default function TheoryRelations({ snapshot, dirty }: { snapshot: TheorySnapshot; dirty: boolean }) {
  const [wiki, setWiki] = useState<Awaited<ReturnType<typeof loadRelationWiki>> | null>(null);
  const [fromKey, setFrom] = useState(''), [targetKey, setTarget] = useState(''), [focusKey, setFocus] = useState('');
  const [targetType, setTargetType] = useState<'claim' | 'reference'>('claim');
  const [sourceId, setSource] = useState('');
  const [kind, setKind] = useState<ResearchRelation['kind']>('depends_on');
  const [dependencyType, setDependencyType] = useState<'proof' | 'concept'>('concept');
  const [label, setLabel] = useState<typeof COMPATIBILITY_LABELS[number]>('insufficient_evidence');
  const [theoryConditions, setTheoryConditions] = useState(''), [referenceConditions, setReferenceConditions] = useState('');
  const [note, setNote] = useState(''), [retractionNote, setRetractionNote] = useState('');
  const [preview, setPreview] = useState<{ key: string; proposal: RelationProposal } | null>(null);
  const [evidence, setEvidence] = useState<ContextEvidence | null>(null);
  const [rawBlock, setRawBlock] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () => void loadRelationWiki(snapshot.document.id).then(value => { if (active) setWiki(value); }).catch(() => { if (active) setError('주장 관계를 읽지 못했습니다.'); });
    refresh(); const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [snapshot.document.id, snapshot.version.id]);
  const current = wiki?.snapshot.version.id === snapshot.version.id;
  const claims = wiki?.runs.flatMap(run => run.claims.map(claim => ({ run, claim, key: JSON.stringify(['claim', run.id, claim.id]) }))) ?? [];
  const accepted = claims.filter(n => n.run.versionId === snapshot.version.id && n.claim.acceptance === 'accepted');
  const focus = claims.find(n => n.key === focusKey);
  const activeRelations = wiki?.entries.filter(e => e.status === 'active').map(e => e.relation) ?? [];
  const graph = relationGraph(activeRelations, focusKey);
  const key = JSON.stringify([snapshot.version.id, fromKey, targetKey, targetType, sourceId, kind, dependencyType, label, theoryConditions, referenceConditions, note]);
  const visiblePreview = preview?.key === key && !dirty && current ? preview.proposal : null;
  const execute = async (task: () => Promise<void>) => {
    setBusy(true); setError(''); setStatus('');
    try { await task(); setWiki(await loadRelationWiki(snapshot.document.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '관계 작업 실패'); }
    finally { setBusy(false); }
  };
  const openReference = (relation: ResearchRelation) => {
    if (!wiki || relation.to.type !== 'reference') return;
    const target = relation.to;
    const source = wiki.references.find(s => s.id === target.sourceId), span = wiki.spans.find(s => s.id === target.spanId);
    if (!source || !span) { setError('고정한 원문 구간이 없습니다.'); return; }
    const own = wiki.snapshot.history.find(v => v.contentHash === source.contentHash);
    const item = createContextBundle('관계 원문 확인', [source.id], [{ source: own ? { ...source, role: 'theory_snapshot', originVersionId: own.id } : source, span, score: 0 }]);
    setEvidence(item.evidence[0]);
  };
  const claimName = (node: typeof claims[number]) => `${node.run.versionId === snapshot.version.id ? '현재' : '과거'} · ${node.claim.kind} · ${node.claim.statement.slice(0, 70)} · ${node.claim.id.slice(0, 8)}`;
  return <section aria-label="주장 관계와 Wiki" className="theory-review">
    <h3>주장 관계 · Wiki · 외부 대조</h3>
    <p>원문에 고정된 채택 주장과 직접 선택한 근거를 연결합니다. 관계 승인과 호환성 표시는 사용자 판단이며 참·증명·내부 정합성 보증이 아닙니다. 자동 API 호출은 없습니다.</p>
    {dirty && <p>미저장 변경이 있습니다. 저장 후 현재 버전의 주장을 검토·채택하고 관계를 다시 승인하세요.</p>}
    {!current && wiki && <p>다른 탭에서 정본 버전을 변경했습니다. 문서를 다시 열어 주세요.</p>}
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    <fieldset disabled={busy || dirty || !current}>
      <legend>관계 작성 — 현재 채택 주장만</legend>
      {!accepted.length && <p>문서 검토에서 주장 후보를 채택한 뒤 ‘관계 목록 새로고침’을 눌러 주세요.</p>}
      <button type="button" onClick={() => void execute(async () => {})}>관계 목록 새로고침</button>
      <label>출발 주장<select aria-label="출발 주장" value={fromKey} onChange={event => setFrom(event.target.value)}><option value="">선택</option>{accepted.map(n => <option key={n.key} value={n.key}>{claimName(n)}</option>)}</select></label>
      <label>연결 대상 종류<select value={targetType} onChange={event => { const type = event.target.value as typeof targetType; setTargetType(type); setTarget(''); setKind(type === 'claim' ? 'depends_on' : 'supports'); }}><option value="claim">채택 주장</option><option value="reference">선택 원문 구간</option></select></label>
      {targetType === 'reference' && <label>연결할 레퍼런스<select value={sourceId} onChange={event => { setSource(event.target.value); setTarget(''); }}><option value="">자료를 직접 선택</option>{wiki?.references.map(s => <option key={s.id} value={s.id}>{s.name} · {s.role}</option>)}</select></label>}
      <label>도착 주장 또는 구간<select value={targetKey} onChange={event => setTarget(event.target.value)}><option value="">선택</option>{targetType === 'claim'
        ? accepted.filter(n => n.key !== fromKey).map(n => <option key={n.key} value={n.key}>{claimName(n)}</option>)
        : wiki?.spans.filter(s => s.sourceId === sourceId).map(s => <option key={s.id} value={s.id}>{spanLocation(s)} · {s.text.slice(0, 70)}</option>)}</select></label>
      <label>관계 종류<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}>{RELATION_KINDS.filter(k => targetType === 'claim' || ['supports', 'contradicts'].includes(k)).map(k => <option key={k} value={k}>{kindLabels[k]}</option>)}</select></label>
      {kind === 'depends_on' && <label>의존성 종류<select value={dependencyType} onChange={event => setDependencyType(event.target.value as typeof dependencyType)}><option value="concept">개념 연결 — 순환 허용</option><option value="proof">증명 의존성 — 순환 후보 검사</option></select></label>}
      {targetType === 'reference' && <>
        <label>외부 대조 분류<select value={label} onChange={event => setLabel(event.target.value as typeof label)}>{COMPATIBILITY_LABELS.map(l => <option key={l} value={l}>{l}</option>)}</select></label>
        <label>자체 주장 가정·정의·범위<textarea value={theoryConditions} maxLength={2000} onChange={event => setTheoryConditions(event.target.value)} /></label>
        <label>원문 결과의 가정·정의·범위<textarea value={referenceConditions} maxLength={2000} onChange={event => setReferenceConditions(event.target.value)} /></label>
        <p>메모·자체 문서 및 같은 hash의 정본은 독립 외부 증거로 집계하지 않습니다. conflict_candidate는 내부 모순 판정이 아닙니다.</p>
      </>}
      <label>관계 승인 사유<textarea value={note} maxLength={2000} onChange={event => setNote(event.target.value)} /></label>
      <button type="button" disabled={!fromKey || !targetKey || !note.trim()} onClick={() => void execute(async () => {
        const from = accepted.find(n => n.key === fromKey); if (!from || !wiki) throw new Error('현재 채택 주장을 다시 선택하세요.');
        const target = accepted.find(n => n.key === targetKey);
        const source = wiki.references.find(s => s.id === sourceId), span = wiki.spans.find(s => s.id === targetKey && s.sourceId === sourceId);
        const to = targetType === 'claim' && target ? claimAnchor(target.run, target.claim.id)
          : targetType === 'reference' && source && span ? { type: 'reference' as const, sourceId: source.id, sourceHash: source.contentHash, spanId: span.id, spanHash: span.contentHash, quote: span.text } : null;
        if (!to) throw new Error('도착 주장/선택 원문을 다시 확인하세요.');
        if (to.type === 'reference' && (!theoryConditions.trim() || !referenceConditions.trim())) throw new Error('대조하는 양쪽의 가정·정의·범위를 기록하세요.');
        setPreview({ key, proposal: { documentId: snapshot.document.id, from: claimAnchor(from.run, from.claim.id), to, kind,
          dependencyType: kind === 'depends_on' ? dependencyType : null, note: note.trim(),
          assessment: to.type === 'reference' ? { label, theoryConditions: theoryConditions.trim(), referenceConditions: referenceConditions.trim() } : null } });
      })}>관계 승인 미리보기</button>
    </fieldset>
    {visiblePreview && <section aria-label="관계 승인 미리보기">
      <p>{kindLabels[visiblePreview.kind]} · 정본 {visiblePreview.from.versionId} · 출발/도착 원문을 확인하세요.</p>
      <pre>{visiblePreview.from.quote}</pre><pre>{visiblePreview.to.quote}</pre>
      <p>사유: {visiblePreview.note}</p>
      {visiblePreview.assessment && <p>사용자 대조 {visiblePreview.assessment.label} · 자체 조건: {visiblePreview.assessment.theoryConditions} · 원문 조건: {visiblePreview.assessment.referenceConditions}</p>}
      <button type="button" disabled={busy} onClick={() => void execute(async () => { await approveRelation(visiblePreview); setPreview(null); setStatus('원문 고정 관계를 승인·저장했습니다. 증명 또는 정합성 판정이 아닙니다.'); })}>이 관계 승인·저장</button>
    </section>}
    <section aria-label="Research Wiki">
      <h4>Research Wiki — 원문과 승인 관계의 파생 뷰</h4>
      <button type="button" disabled={busy || !wiki} onClick={() => void execute(async () => {
        const currentWiki = await loadRelationWiki(snapshot.document.id);
        const url = URL.createObjectURL(new Blob([relationWikiToMarkdown(currentWiki)], { type: 'text/markdown;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = `qaxiom-wiki-v${currentWiki.snapshot.version.number}.md`; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      })}>Research Wiki 내보내기</button>
      <label>Wiki 주장<select aria-label="Wiki 주장" value={focusKey} onChange={event => setFocus(event.target.value)}><option value="">탐색할 주장 선택</option>{claims.map(n => <option key={n.key} value={n.key}>{claimName(n)} · {n.claim.acceptance}</option>)}</select></label>
      {focus && <>
        <p>검토 {focus.run.id} · 버전 {focus.run.versionId} · 블록 {focus.claim.blockId} · {focus.claim.acceptance}</p>
        <pre>{focus.claim.statement}</pre>
        <button type="button" disabled={busy} onClick={() => void execute(async () => {
          const block = await qaxiomDatabase.document_blocks.get([focus.run.versionId, focus.claim.blockId]);
          if (!block || block.contentHash !== focus.claim.blockHash || await hashText(block.text) !== focus.claim.blockHash) throw new Error('해당 버전의 주장 원문이 없거나 변경되었습니다.');
          setRawBlock({ key: focus.key, text: block.text });
        })}>주장 원문 블록 확인</button>
        {rawBlock?.key === focusKey && <pre aria-label="Wiki 주장 전체 블록">{rawBlock.text}</pre>}
        <p>현재 승인 링크: 출발 {graph.outgoing.length} · 역참조 {graph.incoming.length} · 의존 전제 {graph.dependencies.length} · 수정 영향 주장 {graph.impacted.length}. 미선언 관계는 포함하지 않습니다.</p>
        <details><summary>의존 전제와 수정 영향 목록</summary>{[...graph.dependencies.map(id => ({ id, label: '전제' })), ...graph.impacted.map(id => ({ id, label: '영향' }))].map(n => <p key={n.label + n.id}>{n.label}: {claims.find(c => c.key === n.id)?.claim.statement ?? n.id}</p>)}</details>
      </>}
      {!!graph.proofCycleRelationIds.length && <p role="alert">승인된 증명 의존성에 순환 후보 {graph.proofCycleRelationIds.length}개가 있습니다. 개념 연결 순환은 오류로 처리하지 않습니다. 자동 증명 판정이 아닙니다.</p>}
      <p>독립 외부 대조: {wiki?.entries.filter(e => e.status === 'active' && e.independent).length ?? 0}개 · 외부 불일치는 내부 모순과 구분합니다.</p>
    </section>
    <section aria-label="승인 관계 이력">
      <h4>승인 관계 · 역참조 · 이력</h4>
      <label>관계 철회 사유<textarea value={retractionNote} maxLength={2000} onChange={event => setRetractionNote(event.target.value)} /></label>
      {wiki?.entries.filter(e => !focusKey || anchorKey(e.relation.from) === focusKey || anchorKey(e.relation.to) === focusKey).map(({ relation, status: relationStatus, independent, source }) => <article key={relation.id}>
        <p>{kindLabels[relation.kind]} · {statusLabels[relationStatus]} · {relation.id}</p>
        <pre>{relation.from.quote} → {relation.to.quote}</pre><p>{relation.note}</p>
        {relation.externalReviewOrigin && <p>외부 대조 계보: {relation.externalReviewOrigin.runId} · 쌍 {relation.externalReviewOrigin.pairId} · 사용자 별도 승인 (모델 분류 자동 채택 아님)</p>}
        {relation.assessment && <><p>사용자 대조: {relation.assessment.label} · {independent ? '독립 외부 자료' : '메모/자체 문서 — 독립 외부 증거 아님'}</p><p>자체 조건: {relation.assessment.theoryConditions} · 원문 조건: {relation.assessment.referenceConditions}</p></>}
        {source && <button type="button" onClick={() => openReference(relation)}>관계 근거 원문: {source.name}</button>}
        {relation.retractedAt !== null ? <p>철회 사유: {relation.retractionNote}</p> : <button type="button" disabled={busy || !retractionNote.trim()} onClick={() => void execute(async () => { await retractRelation(relation.id, retractionNote); setStatus('관계를 철회했습니다. 기존 승인·원문 이력은 보존합니다.'); })}>이 관계 철회</button>}
      </article>)}
      {!wiki?.entries.length && <p>승인된 관계가 없습니다.</p>}
    </section>
    {evidence && <Suspense fallback={<p>원문 보기 준비 중…</p>}><ReferenceSource evidence={evidence} onClose={() => setEvidence(null)} /></Suspense>}
  </section>;
}
