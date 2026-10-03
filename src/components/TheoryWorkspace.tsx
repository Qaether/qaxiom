import { useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { compareBlocks } from '../services/theory/blocks';
import { createTheory, loadTheory, restoreTheoryVersion, saveTheoryVersion } from '../services/theory/documents';
import { EMPTY_CONTRACT, type ContractAnchors, type DocumentBlock, type ResearchContract, type TheorySnapshot } from '../services/theory/types';
import './TheoryWorkspace.css';
import TheoryReview from './TheoryReview';
import TheoryRelations from './TheoryRelations';
import ProjectManager from './ProjectManager';
import ProjectSources from './ProjectSources';
import ProjectExternalClaims from './ProjectExternalClaims';
import ContractSuggestionAssistant from './ContractSuggestionAssistant';
import type { UserSettings } from '../types';
import { declarationTemplate } from '../services/theory/declarations';
import { deleteTheory, prepareTheoryDeletion } from '../services/theory/theoryDeletion';

import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Bold, Italic, Heading, Code, Quote, List, Sigma, Eye, Edit3 } from 'lucide-react';

const contractLabels: Record<keyof ResearchContract, string> = {
  purpose: '연구 목적', assumptions: '가정·공리', definitions: '핵심 정의',
  symbols: '기호표', scope: '적용 범위', openQuestions: '미해결 문제'
};
const changeLabels: Record<string, string> = {
  added: '추가', changed: '변경', removed: '삭제', moved: '이동', unchanged: '동일'
};

export default function TheoryWorkspace({ onClose, assistantDraft, settings, modelId, initialDocumentId, embedded = false }: {
  onClose: () => void; assistantDraft?: string; settings: UserSettings; modelId: string;
  initialDocumentId?: string | null; embedded?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const contractDetails = useRef<HTMLDetailsElement>(null);
  const [snapshot, setSnapshot] = useState<TheorySnapshot | null>(null);
  const [title, setTitle] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [contract, setContract] = useState<ResearchContract>({ ...EMPTY_CONTRACT });
  const [contractAnchors, setContractAnchors] = useState<ContractAnchors>({});
  const [comparisonId, setComparisonId] = useState('');
  const [comparisonBlocks, setComparisonBlocks] = useState<DocumentBlock[]>([]);
  const [editorTab, setEditorTab] = useState<'write' | 'preview'>('write');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(initialDocumentId));
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const insertMarkdown = (before: string, after = '', placeholder = '') => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = markdown.slice(start, end) || placeholder;
    const nextText = markdown.slice(0, start) + before + selected + after + markdown.slice(end);
    setMarkdown(nextText);
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
    }, 0);
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (title.trim() && markdown.trim() && dirty && !busy) {
        void save();
      }
    }
  };
  const dirty = snapshot
    ? title !== snapshot.version.title || markdown !== snapshot.version.markdown
      || JSON.stringify(contract) !== JSON.stringify(snapshot.version.contract)
      || JSON.stringify(contractAnchors) !== JSON.stringify(snapshot.version.contractAnchors)
    : Boolean(title || markdown || Object.values(contract).some(Boolean) || Object.keys(contractAnchors).length);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (embedded) {
      if (!element.open) {
        try {
          element.show();
        } catch {
          element.setAttribute('open', '');
        }
      }
    } else {
      element.showModal();
    }
    return () => {
      if (element.open) element.close();
    };
  }, [embedded]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const confirmDiscard = () => !dirty || window.confirm('저장하지 않은 문서 변경을 버릴까요?');
  const close = () => { if (!busy && confirmDiscard()) onClose(); };
  const adopt = (value: TheorySnapshot) => {
    setSnapshot(value); setTitle(value.version.title); setMarkdown(value.version.markdown);
    setContract({ ...value.version.contract }); setContractAnchors({ ...value.version.contractAnchors }); setComparisonId(''); setComparisonBlocks([]);
  };
  useEffect(() => {
    if (!initialDocumentId) return;
    let active = true;
    void loadTheory(initialDocumentId).then(value => { if (active) adopt(value); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '문서를 열지 못했습니다.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [initialDocumentId]);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setStatus('');
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : '문서 작업에 실패했습니다.'); }
    finally { setBusy(false); }
  };
  const save = () => run(async () => {
    const input = { title, markdown, contract,
      ...(snapshot && JSON.stringify(contractAnchors) === JSON.stringify(snapshot.version.contractAnchors) ? {} : { contractAnchors }) };
    const saved = snapshot
      ? await saveTheoryVersion(snapshot.document.id, snapshot.version.id, input)
      : await createTheory(input);
    adopt(saved);
    setStatus(`v${saved.version.number} 저장 완료. 이전 버전은 보존됩니다.`);
  });
  const comparison = snapshot?.history.find(version => version.id === comparisonId);
  const changes = snapshot && comparison ? compareBlocks(comparisonBlocks, snapshot.blocks).filter(change => change.change !== 'unchanged') : [];

  return (
    <dialog ref={dialog} className={`theory-workspace ${embedded ? 'embedded' : ''}`} aria-labelledby="theory-heading"
      onCancel={event => { event.preventDefault(); close(); }}>
      <header className="theory-header">
        <div><h2 id="theory-heading">{snapshot ? snapshot.version.title : '새 연구 문서'}</h2><p>{snapshot ? `저장된 v${snapshot.version.number} · 내용을 고치면 새 버전으로 저장합니다.` : '제목과 내용을 적고 저장하세요. 저장 후 AI 분석을 시작할 수 있습니다.'}</p></div>
        <button type="button" onClick={close} disabled={busy}>닫기</button>
      </header>
      <p className="theory-storage-warning">현재 저장 위치: 브라우저 데이터베이스. 선택한 프로젝트 폴더에는 아직 자동 저장되지 않습니다.</p>
      {error && <p role="alert" className="theory-error">{error}</p>}
      {status && <p role="status">{status}</p>}
      <div className={`theory-layout ${snapshot ? 'theory-layout-saved' : 'theory-layout-new'}`} aria-busy={busy || loading}>
        <div className="theory-editor">
          <div className="theory-editor-header-bar">
            <h3>{snapshot ? '1. 문서 수정' : '1. 문서 작성'}</h3>
            <div className="theory-md-tabs">
              <button
                type="button"
                className={`theory-md-tab ${editorTab === 'write' ? 'active' : ''}`}
                onClick={() => setEditorTab('write')}
                title="마크다운 편집 모드"
              >
                <Edit3 size={13} />
                <span>편집</span>
              </button>
              <button
                type="button"
                className={`theory-md-tab ${editorTab === 'preview' ? 'active' : ''}`}
                onClick={() => setEditorTab('preview')}
                title="마크다운 렌더링 미리보기 모드"
              >
                <Eye size={13} />
                <span>미리보기</span>
              </button>
            </div>
          </div>

          <fieldset disabled={busy || loading} className="theory-editor-fieldset">
            <label htmlFor="theory-title">문서 제목</label>
            <input id="theory-title" value={title} autoFocus={!initialDocumentId} onChange={event => setTitle(event.target.value)} placeholder="예: 새로운 물리 모형의 기본 가정" />

            <div className="theory-markdown-header-row">
              <label htmlFor="theory-markdown">문서 본문 (Markdown)</label>
              {editorTab === 'write' && (
                <div className="theory-md-toolbar-actions">
                  <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('### ', '', '제목')} title="제목 3 (###)" aria-label="제목"><Heading size={12} /></button>
                  <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('**', '**', '굵게')} title="굵게 (**텍스트**)" aria-label="굵게"><Bold size={12} /></button>
                  <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('*', '*', '기울임')} title="기울임 (*텍스트*)" aria-label="기울임"><Italic size={12} /></button>
                  <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('$', '$', 'x')} title="인라인 수식 ($x$)" aria-label="인라인 수식"><Sigma size={12} /></button>
                  <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('```\n', '\n```', 'code')} title="코드 블록" aria-label="코드 블록"><Code size={12} /></button>
                  <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('> ', '', '인용')} title="인용문 (>)" aria-label="인용"><Quote size={12} /></button>
                  <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('- ', '', '목록')} title="글머리 기호 (-)" aria-label="글머리 기호"><List size={12} /></button>
                </div>
              )}
            </div>

            <div className="theory-editor-body">
              <textarea
                ref={textareaRef}
                id="theory-markdown"
                className={`theory-markdown-textarea ${editorTab === 'preview' ? 'hidden' : ''}`}
                value={markdown}
                onChange={event => setMarkdown(event.target.value)}
                onKeyDown={handleEditorKeyDown}
                rows={18}
                placeholder="아이디어, 연구 가설, 수식($...$, $$...$$), 설명을 자유롭게 적으세요. Markdown 문법이 지원됩니다."
              />
              {editorTab === 'preview' && (
                <div className="theory-markdown-preview-pane">
                  {markdown.trim() ? (
                    <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                      {markdown}
                    </ReactMarkdown>
                  ) : (
                    <p className="theory-preview-empty">작성된 마크다운 내용이 없습니다. '편집' 탭에서 본문을 작성하세요.</p>
                  )}
                </div>
              )}
            </div>
          </fieldset>
          {!snapshot && assistantDraft && <details className="theory-import-draft"><summary>최근 대화 답변 가져오기</summary>
            <p>현재 대화의 마지막 AI 답변을 본문에 가져옵니다. 지금 입력한 내용은 바뀌므로 확인한 뒤 실행하세요.</p>
            <button type="button" disabled={busy || loading} onClick={() => {
              if (markdown && !window.confirm('현재 작성한 본문을 최근 AI 답변으로 바꿀까요?')) return;
              setMarkdown(assistantDraft);
            }}>답변을 본문에 넣기</button>
          </details>}
          <fieldset disabled={busy || loading}>
            <div className="theory-actions">
              <button type="button" disabled={!title.trim() || !markdown.trim() || !dirty} onClick={() => void save()}>
                {snapshot ? '새 버전 저장' : '문서 저장'}
              </button>
              <span>{snapshot ? `저장된 v${snapshot.version.number}` : '저장하면 분석을 시작할 수 있습니다.'}{dirty ? ' · 미저장 변경 있음' : ''}</span>
            </div>
          </fieldset>
          {snapshot && <details className="theory-advanced" aria-label="문서 관리">
            <summary>문서 관리</summary>
            <button type="button" className="theory-delete" onClick={() => {
                if (!confirmDiscard()) return;
                void run(async () => {
                  const preview = await prepareTheoryDeletion(snapshot.document.id, snapshot.version.id);
                  const projectNote = preview.projectAction === 'remove' ? '이 문서만 있는 프로젝트도 삭제됩니다.'
                    : preview.projectAction === 'choose_representative' ? '프로젝트의 다른 문서가 대표 문서가 됩니다.' : '프로젝트의 다른 문서는 유지됩니다.';
                  if (!window.confirm(`“${preview.title}” 문서를 삭제할까요?\n\n문서 버전 ${preview.versionCount}개, 문단 ${preview.blockCount}개, 검토 기록 ${preview.reviewCount}개, 검토 회차 ${preview.campaignCount}개, 승인 관계 ${preview.relationCount}개를 함께 삭제합니다. ${projectNote}\n\n이 작업은 현재 작업공간에서 되돌릴 수 없습니다. 이전 JSON 백업이 있다면 복원할 수 있습니다.`)) return;
                  await deleteTheory(preview);
                  setSnapshot(null); setTitle(''); setMarkdown(''); setContract({ ...EMPTY_CONTRACT }); setContractAnchors({});
                  setComparisonId(''); setComparisonBlocks([]);
                  setStatus(`“${preview.title}” 문서를 삭제했습니다. 이전 JSON 백업은 변경하지 않았습니다.`);
                });
              }}>문서 삭제</button>
          </details>}
          {snapshot && <details className="theory-advanced" aria-label="연구 기준과 AI 후보">
            <summary>연구 기준과 AI 후보 · 선택 사항</summary>
            <div className="theory-contract-container">
            <details ref={contractDetails} id="theory-contract-fields" className="theory-contract">
              <summary>연구 기준 — 목적·가정·정의·기호·범위</summary>
              <fieldset disabled={busy || loading}>
                <p>직접 명시한 연구 기준을 문서 버전과 함께 보존합니다. 저장한 버전의 원문 블록에 명시적으로 연결할 수 있습니다. 연결은 출처 추적이지 기준의 참이나 논증의 증명이 아닙니다. 본문 블록을 수정하면 기존 연결 중 원문이 달라진 것은 새 버전에 승계되지 않으므로 저장 후 다시 연결하세요.</p>
                {(Object.keys(contractLabels) as (keyof ResearchContract)[]).map(key => (
                  <div key={key}>
                    <label htmlFor={`contract-${key}`}>{contractLabels[key]}</label>
                    <textarea id={`contract-${key}`} rows={2} value={contract[key]}
                      onChange={event => { setContract(previous => ({ ...previous, [key]: event.target.value })); setContractAnchors(previous => { const next = { ...previous }; delete next[key]; return next; }); }} />
                    {snapshot && <label>근거 블록: {contractLabels[key]}<select value={contractAnchors[key]?.blockId ?? ''} disabled={!contract[key].trim()}
                      onChange={event => setContractAnchors(previous => {
                        const next = { ...previous }; const block = snapshot.blocks.find(item => item.id === event.target.value);
                        if (block) next[key] = { blockId: block.id, blockHash: block.contentHash }; else delete next[key];
                        return next;
                      })}>
                      <option value="">연결 없음</option>{snapshot.blocks.map(block => <option key={block.id} value={block.id}>블록 {block.position + 1} · {block.text.slice(0, 80)}</option>)}
                    </select></label>}
                  </div>
                ))}
              </fieldset>
            </details>
            <ContractSuggestionAssistant key={`suggestions-${snapshot?.document.id ?? 'new'}`} title={title} markdown={markdown} contract={contract}
              modelId={modelId} settings={settings} disabled={busy || loading} onBusyChange={setBusy}
              onOpenCriteria={() => { if (contractDetails.current) contractDetails.current.open = true; }}
              onApply={(values, keys) => {
                if (contractDetails.current) contractDetails.current.open = true;
                setContract(previous => {
                  const next = { ...previous };
                  for (const key of keys) if (values[key]) next[key] = values[key].text;
                  return next;
                });
                setContractAnchors(previous => {
                  const next = { ...previous };
                  for (const key of keys) delete next[key];
                  return next;
                });
                setStatus(`${keys.length}개 연구 기준 후보를 입력했습니다. 확인 후 문서를 저장하세요.`);
              }} />
            </div>
          </details>}
          {snapshot && <details className="theory-advanced" aria-label="프로젝트 관리 및 자료 설정">
            <summary>프로젝트 관리 · 자료 설정</summary>
            <p>프로젝트 이름·문서 이동, 허용 자료, 외부 주장 기록을 관리합니다. 문서 작성과 기본 검토에는 설정할 필요가 없습니다.</p>
            <ProjectManager key={`project-${snapshot.document.id}`} snapshot={snapshot} disabled={busy || dirty} onBusyChanged={setBusy} onChanged={async value => { adopt(value); }} />
            <ProjectSources key={`sources-${snapshot.document.id}`} snapshot={snapshot} disabled={busy || dirty} onBusyChanged={setBusy} />
            <ProjectExternalClaims key={`external-claims-${snapshot.document.projectId}`} snapshot={snapshot} />
          </details>}
          {snapshot && <details className="theory-advanced" aria-label="고급 문서 도구">
            <summary>고급 문서 도구 · 관계와 버전 비교</summary>
            <p>기호·의존성 선언, 주장 관계, 이전 버전 비교가 필요할 때 사용합니다.</p>
            <details aria-label="기호와 의존성 선언">
            <summary>기호 범위 · 증명 의존성 선언</summary>
            <p>정본의 qaxiom-declarations JSON 코드 블록으로 명시합니다. scope가 빈 배열이면 문서 전체 범위입니다. proof 관계의 순환만 검사하며 concept 연결의 순환은 오류가 아닙니다. 원문에 선언하지 않은 기호/의존성을 자동 추론하거나 증명을 보증하지 않습니다.</p>
            <button type="button" disabled={busy || dirty} onClick={() => {
              setMarkdown(previous => previous + declarationTemplate(snapshot.blocks)); setStatus('선언 템플릿을 초안에 추가했습니다. 실제 의미·원문 ID·범위를 수정한 뒤 새 버전으로 저장하세요.');
            }}>기호·의존성 선언 템플릿 추가</button>
            <p>symbols: name/meaning/definedAt/scope · uses: name/at · dependencies: from/to/kind(proof 또는 concept)</p>
            <ul>{snapshot.blocks.map(block => <li key={block.id}>블록 {block.position + 1}: <code>{block.id}</code> · {block.text.slice(0, 80)}</li>)}</ul>
            </details>
            <TheoryRelations key={`relations-${snapshot.document.id}`} snapshot={snapshot} dirty={dirty} />
            <section className="theory-history" aria-label="버전 비교">
            <h3>버전 비교</h3>
            <p>선택한 과거 버전과 현재 저장된 v{snapshot.version.number}을 비교합니다.</p>
            <select aria-label="비교할 버전" value={comparisonId} disabled={busy} onChange={event => {
              const id = event.target.value;
              void run(async () => {
                const blocks = id ? await qaxiomDatabase.document_blocks.where('versionId').equals(id).sortBy('position') : [];
                setComparisonBlocks(blocks); setComparisonId(id);
              });
            }}>
              <option value="">비교할 버전 선택</option>
              {snapshot.history.filter(version => version.id !== snapshot.version.id).map(version => (
                <option key={version.id} value={version.id}>v{version.number} — {version.title}</option>
              ))}
            </select>
            {comparison && <>
              <button type="button" disabled={busy} onClick={() => {
                if (!confirmDiscard() || !window.confirm(`v${comparison.number}의 내용을 새 버전으로 복원할까요? 모든 과거 버전은 유지됩니다.`)) return;
                void run(async () => {
                  const saved = await restoreTheoryVersion(snapshot.document.id, snapshot.version.id, comparison.id);
                  adopt(saved); setStatus(`v${saved.version.number}으로 복원 완료.`);
                });
              }}>이 버전으로 복원</button>
              {comparison.title !== snapshot.version.title && <p>제목: {comparison.title} → {snapshot.version.title}</p>}
              {(Object.keys(contractLabels) as (keyof ResearchContract)[]).filter(key => comparison.contract[key] !== snapshot.version.contract[key]).map(key => (
                <div className="theory-change" key={key}><strong>{contractLabels[key]} 변경</strong>
                  <div className="theory-diff"><pre>{comparison.contract[key] || '(없음)'}</pre><pre>{snapshot.version.contract[key] || '(없음)'}</pre></div>
                </div>
              ))}
              <p>본문 변경 {changes.length}개 · 왼쪽: 과거 / 오른쪽: 현재</p>
              {changes.map(change => <div key={change.id} className="theory-change">
                <strong>{changeLabels[change.change]}</strong>
                <div className="theory-diff"><pre>{change.before || '(없음)'}</pre><pre>{change.after || '(없음)'}</pre></div>
              </div>)}
            </>}
            </section>
          </details>}
        </div>
        {snapshot && <aside className="theory-review-panel" aria-label="AI 분석과 검토 결과">
          <TheoryReview key={snapshot.document.id} snapshot={snapshot} settings={settings} modelId={modelId} dirty={dirty}
            onSaved={saved => { adopt(saved); setStatus(`v${saved.version.number}으로 수정 적용. 현재 버전을 재검사하세요.`); }} />
        </aside>}
      </div>
    </dialog>
  );
}
