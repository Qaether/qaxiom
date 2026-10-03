import { useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { compareBlocks } from '../services/theory/blocks';
import { createTheory, loadTheory, restoreTheoryVersion, saveTheoryVersion } from '../services/theory/documents';
import { EMPTY_CONTRACT, type ContractAnchors, type DocumentBlock, type ResearchContract, type TheorySnapshot } from '../services/theory/types';
import './TheoryWorkspace.css';
import TheoryReview from './TheoryReview';
import ProjectManager from './ProjectManager';
import ProjectSources from './ProjectSources';
import ProjectExternalClaims from './ProjectExternalClaims';
import ContractSuggestionAssistant from './ContractSuggestionAssistant';
import type { UserSettings } from '../types';
import { deleteTheory, prepareTheoryDeletion } from '../services/theory/theoryDeletion';

import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import {
  Bold, Italic, Heading, Code, Quote, List, Sigma, Eye, Edit3,
  Sparkles, BookOpen, GitCompare, FolderKanban, Save, X, Folder, Menu, Check
} from 'lucide-react';

function preprocessLatex(content: string): string {
  if (!content) return '';
  let processed = content;
  // 1. Replace \[ ... \] with $$ ... $$
  processed = processed.replace(/\\\[([\s\S]*?)\\\]/g, (_match, math) => `\n\n$$\n${math.trim()}\n$$\n\n`);
  // 2. Replace \( ... \) with $ ... $
  processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (_match, math) => ` $${math.trim()}$ `);
  // 3. Replace \begin{equation} ... \end{equation} with $$ ... $$
  processed = processed.replace(/\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g, (_match, math) => `\n\n$$\n${math.trim()}\n$$\n\n`);
  // 4. Replace \begin{align} ... \end{align} with $$ \begin{aligned} ... \end{aligned} $$
  processed = processed.replace(/\\begin\{align\*?\}([\s\S]*?)\\end\{align\*?\}/g, (_match, math) => `\n\n$$\\begin{aligned}\n${math.trim()}\n\\end{aligned}$$\n\n`);
  // 5. Replace \begin{gather} ... \end{gather} with $$ \begin{gathered} ... \end{gathered} $$
  processed = processed.replace(/\\begin\{gather\*?\}([\s\S]*?)\\end\{gather\*?\}/g, (_match, math) => `\n\n$$\\begin{gathered}\n${math.trim()}\n\\end{gathered}$$\n\n`);
  // 6. Common LaTeX section commands if user pasted pure latex
  processed = processed.replace(/^\\section\*?\{([^}]+)\}/gm, '# $1');
  processed = processed.replace(/^\\subsection\*?\{([^}]+)\}/gm, '## $1');
  processed = processed.replace(/^\\subsubsection\*?\{([^}]+)\}/gm, '### $1');
  processed = processed.replace(/\\textbf\{([^}]+)\}/g, '**$1**');
  processed = processed.replace(/\\textit\{([^}]+)\}/g, '*$1*');
  processed = processed.replace(/\\emph\{([^}]+)\}/g, '*$1*');
  return processed;
}

const contractLabels: Record<keyof ResearchContract, string> = {
  purpose: '연구 목적', assumptions: '가정·공리', definitions: '핵심 정의',
  symbols: '기호표', scope: '적용 범위', openQuestions: '미해결 문제'
};
const changeLabels: Record<string, string> = {
  added: '추가', changed: '변경', removed: '삭제', moved: '이동', unchanged: '동일'
};

type ActiveModal = 'review' | 'contract' | 'history' | 'project' | null;

export default function TheoryWorkspace({
  onClose,
  assistantDraft,
  settings,
  modelId,
  initialDocumentId,
  embedded = false,
  projectName,
  onChangeProject,
  onOpenMobileMenu,
  onNewDocument,
}: {
  onClose: () => void;
  assistantDraft?: string;
  settings: UserSettings;
  modelId: string;
  initialDocumentId?: string | null;
  embedded?: boolean;
  projectName?: string;
  onChangeProject?: () => void;
  onOpenMobileMenu?: () => void;
  onNewDocument?: () => void;
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
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(initialDocumentId));
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleButtonRef = useRef<HTMLButtonElement>(null);

  const finishTitleEditing = () => {
    setIsEditingTitle(false);
    requestAnimationFrame(() => titleButtonRef.current?.focus());
  };

  const handleTitleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (titleDraft.trim()) {
      setTitle(titleDraft.trim());
    }
    finishTitleEditing();
  };

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
    setSnapshot(value);
    setTitle(value.version.title);
    setTitleDraft(value.version.title);
    setIsEditingTitle(false);
    setMarkdown(value.version.markdown);
    setContract({ ...value.version.contract });
    setContractAnchors({ ...value.version.contractAnchors });
    setComparisonId('');
    setComparisonBlocks([]);
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
      {/* 1. 상단바: 단일 통합 상단바 (프로젝트 칩 + 인라인 타이틀 편집 + 작업 버튼) */}
      <header className="theory-header">
        <div className="theory-header-meta">
          {onOpenMobileMenu && (
            <button
              type="button"
              id="mobile-menu-btn"
              className="mobile-menu-btn"
              onClick={onOpenMobileMenu}
              aria-label="대화 메뉴 열기"
            >
              <Menu size={18} />
            </button>
          )}

          {/* 프로젝트명 칩 (📁 Qaether Theory) */}
          {projectName && onChangeProject && (
            <button
              type="button"
              className="header-project-chip"
              onClick={onChangeProject}
              title="프로젝트 관리 / 전환 화면으로 이동"
              aria-label={`현재 프로젝트: ${projectName}. 클릭하여 프로젝트 관리 화면으로 이동`}
            >
              <Folder size={13} className="header-project-icon" />
              <span className="header-project-name">{projectName}</span>
            </button>
          )}

          {/* 프로젝트명 바로 오른쪽에 위치한 문서 제목 표시/편집 영역 */}
          {(!snapshot || isEditingTitle) ? (
            <form onSubmit={handleTitleSubmit} className="title-edit-form theory-title-edit-form">
              <label htmlFor="theory-title" className="sr-only">문서 제목</label>
              <input
                id="theory-title"
                className="title-edit-input theory-title-edit-input"
                aria-label="문서 제목"
                value={isEditingTitle ? titleDraft : title}
                onChange={e => {
                  setTitleDraft(e.target.value);
                  setTitle(e.target.value);
                }}
                placeholder="문서 제목을 입력하세요"
                autoFocus={!initialDocumentId || isEditingTitle}
                maxLength={100}
                disabled={busy || loading}
                onBlur={event => {
                  if (!event.currentTarget.form?.contains(event.relatedTarget as Node | null)) {
                    if (snapshot) finishTitleEditing();
                  }
                }}
                onKeyDown={event => {
                  if (event.key === 'Escape' && snapshot) finishTitleEditing();
                }}
              />
              <button type="submit" className="title-save-btn" aria-label="문서 제목 저장" title="문서 제목 저장">
                <Check size={14} />
              </button>
              <h2 id="theory-heading" className="sr-only">
                {title.trim() || (snapshot ? snapshot.version.title : '새 연구 문서')}
              </h2>
            </form>
          ) : (
            <div className="title-display theory-title-display">
              <h2 id="theory-heading" aria-label={title || '연구 문서'}>
                <button
                  ref={titleButtonRef}
                  type="button"
                  className="title-edit-btn theory-title-edit-btn"
                  onClick={() => {
                    setTitleDraft(title);
                    setIsEditingTitle(true);
                  }}
                  aria-label={`${title || '연구 문서'} 제목 수정`}
                  title="클릭하여 문서 제목 수정"
                >
                  <span>{title || '연구 문서'}</span>
                  <Edit3 size={13} className="edit-icon" />
                </button>
              </h2>
            </div>
          )}

          {snapshot && <span className="theory-version-chip">v{snapshot.version.number}</span>}
          {dirty && <span className="theory-dirty-indicator" title="저장되지 않은 변경사항이 있습니다">● 미저장</span>}
        </div>

        <div className="theory-header-actions">
          {snapshot && (
            <aside className="theory-top-ai-aside" aria-label="AI 분석과 검토 결과">
              <button
                type="button"
                className={`theory-topbar-btn theory-btn-ai ${activeModal === 'review' ? 'active' : ''}`}
                onClick={() => setActiveModal(activeModal === 'review' ? null : 'review')}
                title="AI 분석 및 정합성 검토"
                aria-label="AI로 문서 분석"
              >
                <Sparkles size={16} />
              </button>
            </aside>
          )}

          {snapshot && (
            <button
              type="button"
              className={`theory-topbar-btn ${activeModal === 'contract' ? 'active' : ''}`}
              onClick={() => setActiveModal(activeModal === 'contract' ? null : 'contract')}
              title="연구 기준 (목적·가정·정의·기호·범위)"
              aria-label="연구 기준"
            >
              <BookOpen size={16} />
            </button>
          )}

          {snapshot && (
            <button
              type="button"
              className={`theory-topbar-btn ${activeModal === 'history' ? 'active' : ''}`}
              onClick={() => setActiveModal(activeModal === 'history' ? null : 'history')}
              title="과거 버전 비교 및 복원"
              aria-label="버전 비교"
            >
              <GitCompare size={16} />
            </button>
          )}

          {snapshot && (
            <button
              type="button"
              className={`theory-topbar-btn ${activeModal === 'project' ? 'active' : ''}`}
              onClick={() => setActiveModal(activeModal === 'project' ? null : 'project')}
              title="프로젝트 자료 설정 및 문서 관리"
              aria-label="자료·설정"
            >
              <FolderKanban size={16} />
            </button>
          )}

          <button
            type="button"
            className="theory-topbar-btn theory-btn-save"
            disabled={!title.trim() || !markdown.trim() || !dirty || busy}
            onClick={() => void save()}
            title={snapshot ? '새 버전 저장 (Cmd/Ctrl+S)' : '문서 저장'}
            aria-label={snapshot ? '새 버전 저장' : '문서 저장'}
          >
            <Save size={16} />
          </button>

          <button
            type="button"
            className="theory-topbar-btn theory-btn-close"
            onClick={close}
            disabled={busy}
            title="문서 닫기"
            aria-label="닫기"
          >
            <X size={16} />
          </button>
        </div>
      </header>

      {error && <p role="alert" className="theory-error-banner">{error}</p>}
      {status && <p role="status" className="theory-status-banner">{status}</p>}

      {/* 2. 에디터 본체: VCS 스타일의 풀스크린 마크다운 편집기 */}
      <div className="theory-editor-container vcs-mode" aria-busy={busy || loading}>
        <div className="theory-editor-toolbar-bar">
          <div className="theory-editor-toolbar-left">
            {!snapshot && (
              <div className="theory-editor-step-label">
                <h3>1. 문서 작성</h3>
              </div>
            )}

            {editorTab === 'write' && (
              <div className="theory-md-toolbar-actions">
                <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('### ', '', '제목')} title="제목 3 (###)" aria-label="제목"><Heading size={13} /></button>
                <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('**', '**', '굵게')} title="굵게 (**텍스트**)" aria-label="굵게"><Bold size={13} /></button>
                <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('*', '*', '기울임')} title="기울임 (*텍스트*)" aria-label="기울임"><Italic size={13} /></button>
                <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('$', '$', 'x')} title="인라인 수식 ($x$)" aria-label="인라인 수식"><Sigma size={13} /></button>
                <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('```\n', '\n```', 'code')} title="코드 블록" aria-label="코드 블록"><Code size={13} /></button>
                <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('> ', '', '인용')} title="인용문 (>)" aria-label="인용"><Quote size={13} /></button>
                <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('- ', '', '목록')} title="글머리 기호 (-)" aria-label="글머리 기호"><List size={13} /></button>
              </div>
            )}
          </div>

          <div className="theory-editor-actions-bar">
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
        </div>

        {/* 순수 편집기 본문: 화면 전체를 채움 */}
        <label htmlFor="theory-markdown" className="sr-only">문서 본문 (Markdown)</label>
        <div className="theory-editor-body vcs-editor-body">
          <textarea
            ref={textareaRef}
            id="theory-markdown"
            className={`theory-markdown-textarea vcs-textarea ${editorTab === 'preview' ? 'hidden' : ''}`}
            value={markdown}
            onChange={event => setMarkdown(event.target.value)}
            onKeyDown={handleEditorKeyDown}
            placeholder="아이디어, 연구 가설, 수식($...$, $$...$$), 설명을 자유롭게 적으세요. Markdown 문법이 지원됩니다."
            aria-label="문서 본문 (Markdown)"
          />
          {editorTab === 'preview' && (
            <div className="theory-markdown-preview-pane vcs-preview-pane">
              {markdown.trim() ? (
                <ReactMarkdown
                  remarkPlugins={[remarkMath]}
                  rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
                >
                  {preprocessLatex(markdown)}
                </ReactMarkdown>
              ) : (
                <p className="theory-preview-empty">작성된 마크다운 내용이 없습니다. '편집' 탭에서 본문을 작성하세요.</p>
              )}
            </div>
          )}
        </div>

        {/* 에디터 하단 미니멀 정보 바 */}
        <div className="theory-editor-footer-bar">
          <div className="theory-footer-stats">
            <span>{markdown.length}자</span>
            <span>·</span>
            <span>{markdown ? markdown.split('\n').length : 0}줄</span>
            {dirty && <span className="theory-footer-dirty">● 미저장 변경 있음</span>}
          </div>

          {!snapshot && assistantDraft && (
            <button
              type="button"
              className="theory-btn-draft-import"
              onClick={() => {
                if (markdown && !window.confirm('현재 작성한 본문을 최근 AI 답변으로 바꿀까요?')) return;
                setMarkdown(assistantDraft);
              }}
            >
              최근 대화 답변 본문에 가져오기
            </button>
          )}
        </div>
      </div>

      {/* 3. 분석/도구 절차 팝업 모달 다이얼로그 */}
      {activeModal && (
        <div className="theory-modal-backdrop" onClick={() => setActiveModal(null)}>
          <div className="theory-modal-container" onClick={e => e.stopPropagation()}>
            <div className="theory-modal-header">
              <h3>
                {activeModal === 'review' && 'AI 문서 분석 및 정합성 검토'}
                {activeModal === 'contract' && '연구 기준 설정 및 AI 후보 제안'}
                {activeModal === 'history' && '문서 버전 비교 및 과거 버전 복원'}
                {activeModal === 'project' && '프로젝트 자료 설정 및 문서 관리'}
              </h3>
              <button
                type="button"
                className="theory-modal-close-btn"
                onClick={() => setActiveModal(null)}
                title="창 닫기"
              >
                <X size={16} />
              </button>
            </div>

            <div className="theory-modal-content">
              {activeModal === 'review' && snapshot && (
                <TheoryReview
                  key={snapshot.document.id}
                  snapshot={snapshot}
                  settings={settings}
                  modelId={modelId}
                  dirty={dirty}
                  onSaved={saved => {
                    adopt(saved);
                    setStatus(`v${saved.version.number}으로 수정 적용. 현재 버전을 재검사하세요.`);
                  }}
                />
              )}

              {activeModal === 'contract' && (
                <div className="theory-contract-modal-view">
                  <details ref={contractDetails} id="theory-contract-fields" className="theory-contract" open>
                    <summary>연구 기준 — 목적·가정·정의·기호·범위</summary>
                    <fieldset disabled={busy || loading}>
                      <p className="theory-modal-hint">직접 명시한 연구 기준을 문서 버전과 함께 보존합니다. 본문 블록과 명시적으로 연결할 수 있습니다.</p>
                      {(Object.keys(contractLabels) as (keyof ResearchContract)[]).map(key => (
                        <div key={key} className="theory-contract-item">
                          <label htmlFor={`contract-${key}`}>{contractLabels[key]}</label>
                          <textarea
                            id={`contract-${key}`}
                            rows={2}
                            value={contract[key]}
                            onChange={event => {
                              setContract(previous => ({ ...previous, [key]: event.target.value }));
                              setContractAnchors(previous => {
                                const next = { ...previous };
                                delete next[key];
                                return next;
                              });
                            }}
                          />
                          {snapshot && (
                            <label className="theory-anchor-selector">
                              <span>근거 블록 연결:</span>
                              <select
                                value={contractAnchors[key]?.blockId ?? ''}
                                disabled={!contract[key].trim()}
                                onChange={event => setContractAnchors(previous => {
                                  const next = { ...previous };
                                  const block = snapshot.blocks.find(item => item.id === event.target.value);
                                  if (block) next[key] = { blockId: block.id, blockHash: block.contentHash };
                                  else delete next[key];
                                  return next;
                                })}
                              >
                                <option value="">연결 없음</option>
                                {snapshot.blocks.map(block => (
                                  <option key={block.id} value={block.id}>블록 {block.position + 1} · {block.text.slice(0, 60)}</option>
                                ))}
                              </select>
                            </label>
                          )}
                        </div>
                      ))}
                    </fieldset>
                  </details>

                  <ContractSuggestionAssistant
                    key={`suggestions-${snapshot?.document.id ?? 'new'}`}
                    title={title}
                    markdown={markdown}
                    contract={contract}
                    modelId={modelId}
                    settings={settings}
                    disabled={busy || loading}
                    onBusyChange={setBusy}
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
                    }}
                  />
                </div>
              )}

              {activeModal === 'history' && snapshot && (
                <section className="theory-history" aria-label="버전 비교">
                  <p className="theory-modal-hint">과거 버전을 선택하여 현재 저장된 v{snapshot.version.number}과의 변경점을 확인합니다.</p>
                  <select
                    aria-label="비교할 버전"
                    value={comparisonId}
                    disabled={busy}
                    className="theory-version-select"
                    onChange={event => {
                      const id = event.target.value;
                      void run(async () => {
                        const blocks = id ? await qaxiomDatabase.document_blocks.where('versionId').equals(id).sortBy('position') : [];
                        setComparisonBlocks(blocks);
                        setComparisonId(id);
                      });
                    }}
                  >
                    <option value="">비교할 버전 선택</option>
                    {snapshot.history.filter(version => version.id !== snapshot.version.id).map(version => (
                      <option key={version.id} value={version.id}>v{version.number} — {version.title}</option>
                    ))}
                  </select>

                  {comparison && (
                    <div className="theory-history-comparison-view">
                      <button
                        type="button"
                        className="theory-restore-btn"
                        disabled={busy}
                        onClick={() => {
                          if (!confirmDiscard() || !window.confirm(`v${comparison.number}의 내용을 새 버전으로 복원할까요? 모든 과거 버전은 유지됩니다.`)) return;
                          void run(async () => {
                            const saved = await restoreTheoryVersion(snapshot.document.id, snapshot.version.id, comparison.id);
                            adopt(saved);
                            setStatus(`v${saved.version.number}으로 복원 완료.`);
                            setActiveModal(null);
                          });
                        }}
                      >
                        이 버전으로 복원
                      </button>
                      {comparison.title !== snapshot.version.title && (
                        <p className="theory-diff-title-change">제목 변경: {comparison.title} → {snapshot.version.title}</p>
                      )}
                      {(Object.keys(contractLabels) as (keyof ResearchContract)[]).filter(key => comparison.contract[key] !== snapshot.version.contract[key]).map(key => (
                        <div className="theory-change" key={key}>
                          <strong>{contractLabels[key]} 변경</strong>
                          <div className="theory-diff"><pre>{comparison.contract[key] || '(없음)'}</pre><pre>{snapshot.version.contract[key] || '(없음)'}</pre></div>
                        </div>
                      ))}
                      <p className="theory-diff-count-label">본문 변경 {changes.length}개 · 왼쪽: 과거 / 오른쪽: 현재</p>
                      {changes.map(change => (
                        <div key={change.id} className="theory-change">
                          <strong>{changeLabels[change.change]}</strong>
                          <div className="theory-diff"><pre>{change.before || '(없음)'}</pre><pre>{change.after || '(없음)'}</pre></div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {activeModal === 'project' && snapshot && (
                <div className="theory-project-modal-view">
                  <ProjectManager
                    key={`project-${snapshot.document.id}`}
                    snapshot={snapshot}
                    disabled={busy || dirty}
                    onBusyChanged={setBusy}
                    onChanged={async value => { adopt(value); }}
                  />
                  <ProjectSources
                    key={`sources-${snapshot.document.id}`}
                    snapshot={snapshot}
                    disabled={busy || dirty}
                    onBusyChanged={setBusy}
                  />
                  <ProjectExternalClaims
                    key={`external-claims-${snapshot.document.projectId}`}
                    snapshot={snapshot}
                  />

                  <div className="theory-danger-zone">
                    <h4>문서 삭제</h4>
                    <p className="theory-danger-hint">문서 버전, 문단, 검토 기록을 삭제합니다. 작업공간에서 되돌릴 수 없습니다.</p>
                    <button
                      type="button"
                      className="theory-delete"
                      onClick={() => {
                        if (!confirmDiscard()) return;
                        void run(async () => {
                          const preview = await prepareTheoryDeletion(snapshot.document.id, snapshot.version.id);
                          const projectNote = preview.projectAction === 'remove' ? '이 문서만 있는 프로젝트도 삭제됩니다.'
                            : preview.projectAction === 'choose_representative' ? '프로젝트의 다른 문서가 대표 문서가 됩니다.' : '프로젝트의 다른 문서는 유지됩니다.';
                          if (!window.confirm(`“${preview.title}” 문서를 삭제할까요?\n\n문서 버전 ${preview.versionCount}개, 문단 ${preview.blockCount}개, 검토 기록 ${preview.reviewCount}개를 삭제합니다. ${projectNote}`)) return;
                          await deleteTheory(preview);
                          setSnapshot(null); setTitle(''); setMarkdown(''); setContract({ ...EMPTY_CONTRACT }); setContractAnchors({});
                          setComparisonId(''); setComparisonBlocks([]);
                          setStatus(`“${preview.title}” 문서를 삭제했습니다.`);
                          setActiveModal(null);
                        });
                      }}
                    >
                      문서 삭제
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}
