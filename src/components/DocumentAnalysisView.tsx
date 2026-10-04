import { lazy, Suspense, useState } from 'react';
import type { AnalysisFinding, AnalysisRun } from '../services/theory/analysis';
import type { TheorySnapshot } from '../services/theory/types';

const MathJaxMarkdown = lazy(() => import('./MathJaxMarkdown'));

function changedSpan(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start
    && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  return { prefix: before.slice(0, start), removed: before.slice(start, before.length - end),
    added: after.slice(start, after.length - end), suffix: end ? before.slice(before.length - end) : '' };
}

function SuggestionDiff({ before, after, onApply, disabled }: { before: string; after: string; onApply: () => void; disabled: boolean }) {
  const change = changedSpan(before, after);
  return <div className="document-analysis-diff" aria-label="원문과 수정안 비교">
    <div><strong>− 원문</strong><pre>{change.prefix}<del>{change.removed}</del>{change.suffix}</pre></div>
    <div><strong>+ 수정안</strong><pre>{change.prefix}<ins>{change.added}</ins>{change.suffix}</pre></div>
    <button type="button" disabled={disabled} onClick={onApply}>편집 내용에 적용</button>
  </div>;
}

export default function DocumentAnalysisView({ snapshot, run, onDecision, onApply, onRetry, onCancel, canApply }: {
  snapshot: TheorySnapshot;
  run: AnalysisRun | null;
  onDecision: (finding: AnalysisFinding, decision: AnalysisFinding['decision']) => void;
  onApply: (finding: AnalysisFinding) => void;
  onRetry: () => void;
  onCancel: () => void;
  canApply: boolean;
}) {
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const findings = run?.findings ?? [];
  const unchecked = run ? snapshot.blocks.filter(block => !run.checkedBlockIds.includes(block.id)).length : 0;
  return <section className="document-analysis" aria-label="AI 분석 결과">
    <header className="document-analysis-header">
      <div>
        <strong>{snapshot.version.title} · v{snapshot.version.number}</strong>
        <p>{run?.status === 'running' ? '문서 전체를 AI가 검토 중입니다. 편집 탭으로 이동해도 분석은 계속됩니다.'
          : run?.status === 'complete' ? `검토 의견 ${findings.length}개 · ${run.modelId}`
            : run?.error || '저장된 문서의 분석 결과가 없습니다.'}</p>
      </div>
      {run?.status === 'running' ? <button type="button" onClick={onCancel}>분석 취소</button>
        : <button type="button" onClick={onRetry}>다시 분석</button>}
    </header>
    <p className="document-analysis-disclaimer">AI의 검토 의견이며 이론의 참·증명 또는 완전한 정합성을 보장하지 않습니다. 외부 문헌은 대조하지 않았습니다.</p>
    {run?.status === 'running' && <p role="status">분석 요청을 처리하고 있습니다…</p>}
    {run?.status === 'complete' && <>
      {!!unchecked && <p role="status" className="document-analysis-warning">{unchecked}개 블록은 모델이 검토했다고 보고하지 않았습니다.</p>}
      {run.limitations.map((item, index) => <p key={index} className="document-analysis-warning">검토 한계: {item}</p>)}
      {!findings.length && <p>모델이 지적한 항목이 없습니다. 이는 문서의 정합성 통과 판정이 아닙니다.</p>}
      {!!findings.length && <nav className="document-analysis-index" aria-label="분석 의견 목록">
        {findings.map((finding, index) => <a key={finding.id} href={`#analysis-${finding.id}`}>{index + 1}. {finding.explanation.slice(0, 60)}{finding.decision !== 'open' ? ` · ${finding.decision === 'dismissed' ? '기각' : finding.decision === 'later' ? '나중에 검토' : '적용'}` : ''}</a>)}
      </nav>}
    </>}
    <div className="document-analysis-blocks">
      {snapshot.blocks.map(block => <section key={block.id} className="document-analysis-block">
        <div className="document-analysis-original">
          <Suspense fallback={<pre>{block.text}</pre>}><MathJaxMarkdown content={block.text} /></Suspense>
        </div>
        {findings.filter(item => item.blockId === block.id).map(finding => <article id={`analysis-${finding.id}`} key={finding.id} className={`document-analysis-comment ${finding.decision}`}>
          <span className="document-analysis-arrow" aria-hidden="true">==&gt;</span>
          <div>
            <p><strong>AI 검토</strong> · 원문: <q>{finding.quote}</q></p>
            <p>{finding.explanation}</p>
            <p>확인할 조건: {finding.resolution}</p>
            {finding.replacement && <>
              <button type="button" onClick={() => setOpenDiff(openDiff === finding.id ? null : finding.id)} aria-expanded={openDiff === finding.id}>수정안 {openDiff === finding.id ? '닫기' : '비교'}</button>
              {openDiff === finding.id && <SuggestionDiff before={block.text} after={finding.replacement}
                onApply={() => onApply(finding)} disabled={!canApply || finding.decision === 'applied'} />}
            </>}
            <div className="document-analysis-decisions">
              <button type="button" aria-pressed={finding.decision === 'later'} onClick={() => onDecision(finding, 'later')}>나중에 검토</button>
              <button type="button" aria-pressed={finding.decision === 'dismissed'} onClick={() => onDecision(finding, 'dismissed')}>기각</button>
            </div>
          </div>
        </article>)}
      </section>)}
    </div>
  </section>;
}
