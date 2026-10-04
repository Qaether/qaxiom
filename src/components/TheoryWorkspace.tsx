import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { compareBlocks } from '../services/theory/blocks';
import { createTheory, loadTheory, restoreTheoryVersion, saveTheoryVersion, updateVersionReferenceIds } from '../services/theory/documents';
import { EMPTY_CONTRACT, type ContractAnchors, type DocumentBlock, type ResearchContract, type TheorySnapshot } from '../services/theory/types';
import './TheoryWorkspace.css';
import NoteReferencesModal from './NoteReferencesModal';
import NoteInlineSearchDrawer from './NoteInlineSearchDrawer';
import DocumentAnalysisView from './DocumentAnalysisView';
import { applyAnalysisSuggestion, deleteAnalysisRun, parseDocumentAnalysis, prepareDocumentAnalysis, prepareChunkedDocumentAnalysis, parseChunkedDocumentAnalysis, setAnalysisDecision, type AnalysisFinding, type AnalysisRun } from '../services/theory/analysis';
import { sendChatMessage } from '../services/llm';
import ContractSuggestionAssistant from './ContractSuggestionAssistant';
import type { UserSettings } from '../types';
import type { DocumentDraft } from '../services/documentChat';

import { AVAILABLE_MODELS, estimateTokenCount, formatTokenLimit } from '../constants';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { listWikiPages, publishTheoryToWiki } from '../services/wiki/wikiService';
import {
  Bold, Italic, Heading, Code, Quote, List, Sigma, Eye, Edit3,
  Sparkles, BookOpen, Save, X, Folder, Menu, Check, Cpu, Sliders, BookPlus, Search, Paperclip
} from 'lucide-react';

const MathJaxMarkdown = lazy(() => import('./MathJaxMarkdown'));

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

const ANALYSIS_PRESETS = [
  {
    id: 'comprehensive',
    title: '종합 정합성 검토',
    badge: '기본 추천',
    desc: '주장 간 충돌, 누락된 가정, 정의 불일치, 추론 비약, 적용 범위, 반례 후보 전수 확인',
    instruction: ''
  },
  {
    id: 'math',
    title: '수식 유도 & 기호 체계 검증',
    badge: '수학/물리',
    desc: '수식 유도의 연산 정합성, 차원/지수 일관성, 기호 정의 및 텐서/벡터 표기 일치 여부 집중 검토',
    instruction: '수식 유도 과정의 엄밀성, 차원 분석, 기호 정의의 불일치 및 LaTeX 표기 오류를 집중적으로 검토해 주세요.'
  },
  {
    id: 'assumptions',
    title: '숨은 가정 & 반례 탐색',
    badge: '공리/가정',
    desc: '공리와 전제에 명시되지 않은 은연중 가정, 경계 조건의 맹점, 반례 및 예외 상황 집중 추적',
    instruction: '본문에서 은연중에 전제하고 있는 명시되지 않은 숨은 가정, 적용 범위의 예외 조건 및 잠재적 반례를 중점 탐색해 주세요.'
  },
  {
    id: 'logic',
    title: '논리적 비약 & 단락 충돌',
    badge: '논리 흐름',
    desc: '단락 간 논리적 연결 고리, 전제와 결론 사이의 유도 비약, 텍스트 상호 충돌 조항 검사',
    instruction: '단락 간의 논리적 연결성, 전제에서 결론으로 넘어가는 과정의 비약 및 텍스트 상의 주장 충돌을 집중적으로 검사해 주세요.'
  }
];

type ActiveModal = 'contract' | 'history' | 'analysis' | null;

export default function TheoryWorkspace({
  onClose,
  assistantDraft,
  settings,
  modelId,
  initialDocumentId,
  embedded = false,
  projectName,
  onOpenMobileMenu,
  onContextChange,
  onSaved,
}: {
  onClose: () => void;
  assistantDraft?: string;
  settings: UserSettings;
  modelId: string;
  initialDocumentId?: string | null;
  embedded?: boolean;
  projectName?: string;
  onOpenMobileMenu?: () => void;
  onContextChange?: (draft: DocumentDraft) => void;
  onSaved?: (document: { id: string; title: string; version: number }) => void;
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
  const [editorTab, setEditorTab] = useState<'write' | 'preview' | 'analysis'>('write');
  const [analysisRun, setAnalysisRun] = useState<AnalysisRun | null>(null);
  const [analysisHistory, setAnalysisHistory] = useState<AnalysisRun[]>([]);
  const [historicalAnalysisSnapshot, setHistoricalAnalysisSnapshot] = useState<TheorySnapshot | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const analysisAbort = useRef<AbortController | null>(null);
  const [previewMathRenderer, setPreviewMathRenderer] = useState<'mathjax' | 'katex'>('katex');
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [isSearchDrawerOpen, setIsSearchDrawerOpen] = useState(false);
  const [isReferenceModalOpen, setIsReferenceModalOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(initialDocumentId));
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const [prevModelId, setPrevModelId] = useState<string>(modelId);
  const [analysisModelId, setAnalysisModelId] = useState<string>(modelId);
  const [analysisPreset, setAnalysisPreset] = useState<string>('comprehensive');
  const [analysisCustomInstruction, setAnalysisCustomInstruction] = useState<string>('');
  const [isChunkingEnabled, setIsChunkingEnabled] = useState<boolean>(false);

  if (modelId !== prevModelId) {
    setPrevModelId(modelId);
    setAnalysisModelId(modelId);
  }

  useEffect(() => {
    if (!status) return;
    const timeout = window.setTimeout(() => setStatus(''), 4000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  const [isWikiPublished, setIsWikiPublished] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);

  useEffect(() => {
    if (!snapshot) {
      setIsWikiPublished(false);
      return;
    }
    void (async () => {
      try {
        const pages = await listWikiPages();
        const published = pages.some(p => p.entryType === 'theory_snapshot' && p.versionId === snapshot.version.id);
        setIsWikiPublished(published);
      } catch {
        setIsWikiPublished(false);
      }
    })();
  }, [snapshot?.version.id]);

  const handlePublishToWiki = async () => {
    if (!snapshot || publishBusy) return;
    setPublishBusy(true);
    try {
      await publishTheoryToWiki(snapshot.document, snapshot.version);
      setIsWikiPublished(true);
      setStatus('현재 버전이 Wiki 서고에 등록되었습니다.');
    } catch {
      setStatus('Wiki 등록에 실패했습니다.');
    } finally {
      setPublishBusy(false);
    }
  };

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

  const handleNavigateToLine = (lineNumber: number) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (editorTab !== 'write') {
      setEditorTab('write');
    }

    const lines = markdown.split('\n');
    let startPos = 0;
    for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
      startPos += lines[i].length + 1;
    }
    const lineLen = lines[lineNumber - 1]?.length ?? 0;
    const endPos = startPos + lineLen;

    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(startPos, endPos);
      const lineHeight = 22;
      textarea.scrollTop = Math.max(0, (lineNumber - 3) * lineHeight);
    }, 50);
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
    onContextChange?.({
      documentId: snapshot?.document.id ?? null, versionId: snapshot?.version.id ?? null,
      title, markdown, contract, dirty
    });
  }, [snapshot, title, markdown, contract, dirty, onContextChange]);

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
  const analysisDocumentId = snapshot?.document.id;
  useEffect(() => {
    if (!analysisDocumentId) return;
    let active = true;
    void qaxiomDatabase.analysis_runs.where('documentId').equals(analysisDocumentId).reverse().sortBy('createdAt')
      .then(async runs => {
        if (!active || analysisAbort.current) return;
        const restored = await Promise.all(runs.map(async item => {
          if (item.status !== 'running') return item;
          const stopped: AnalysisRun = { ...item, status: 'stopped', error: '이전 분석 실행이 종료되었습니다. 자동으로 다시 전송하지 않습니다.' };
          await qaxiomDatabase.analysis_runs.put(stopped);
          return stopped;
        }));
        if (active && !analysisAbort.current) { setAnalysisHistory(restored); setAnalysisRun(restored[0] ?? null); }
      })
      .catch(() => { if (active) setError('분석 기록을 읽지 못했습니다.'); });
    return () => { active = false; };
  }, [analysisDocumentId]);
  useEffect(() => {
    if (!analysisRun || !snapshot || analysisRun.versionId === snapshot.version.id) return;
    let active = true;
    void Promise.all([qaxiomDatabase.document_versions.get(analysisRun.versionId),
    qaxiomDatabase.document_blocks.where('versionId').equals(analysisRun.versionId).sortBy('position')])
      .then(([version, blocks]) => {
        if (active && version?.documentId === snapshot.document.id) setHistoricalAnalysisSnapshot({ ...snapshot, version, blocks });
      }).catch(() => { if (active) setError('이전 분석의 문서 버전을 읽지 못했습니다.'); });
    return () => { active = false; };
  }, [analysisRun, snapshot]);
  useEffect(() => () => { analysisAbort.current?.abort(); }, []);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setStatus('');
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : '문서 작업에 실패했습니다.'); }
    finally { setBusy(false); }
  };
  const persistDraft = async () => {
    const input = {
      title, markdown, contract,
      ...(snapshot?.version.referenceIds ? { referenceIds: snapshot.version.referenceIds } : {}),
      ...(snapshot && JSON.stringify(contractAnchors) === JSON.stringify(snapshot.version.contractAnchors) ? {} : { contractAnchors })
    };
    const saved = snapshot
      ? await saveTheoryVersion(snapshot.document.id, snapshot.version.id, input)
      : await createTheory(input);
    adopt(saved);
    onSaved?.({ id: saved.document.id, title: saved.version.title, version: saved.version.number });
    setStatus(`v${saved.version.number} 저장 완료. 이전 버전은 보존됩니다.`);
    return saved;
  };
  const save = () => run(async () => { await persistDraft(); });

  const handleUpdateVersionReferenceIds = async (newIds: string[]) => {
    if (!snapshot) return;
    await updateVersionReferenceIds(snapshot.version.id, newIds);
    setSnapshot(prev => prev ? {
      ...prev,
      version: { ...prev.version, referenceIds: newIds }
    } : null);
  };

  const handleInsertQuote = (quoteText: string, sourceName: string, locationStr: string) => {
    const quoteMarkdown = `\n\n> "${quoteText}"\n> — *출처: ${sourceName}${locationStr ? ` (${locationStr})` : ''}*\n\n`;
    const textarea = textareaRef.current;
    if (!textarea) {
      setMarkdown(prev => prev + quoteMarkdown);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = markdown.slice(0, start);
    const after = markdown.slice(end);
    setMarkdown(before + quoteMarkdown + after);
    setTimeout(() => {
      textarea.focus();
      const newCursor = start + quoteMarkdown.length;
      textarea.setSelectionRange(newCursor, newCursor);
    }, 50);
  };
  const startAnalysis = async (overrideModelId?: string, overrideInstruction?: string, useChunking = isChunkingEnabled) => {
    if (analysisBusy || busy) return;
    const targetModelId = overrideModelId || analysisModelId || modelId;
    setAnalysisBusy(true); setError('');
    let activeRun: AnalysisRun | null = null;
    const abort = new AbortController();
    analysisAbort.current = abort;
    try {
      if (!title.trim() || !markdown.trim()) throw new Error('문서 제목과 본문을 입력해 주세요.');
      const target = dirty || !snapshot ? await persistDraft() : snapshot;
      if (dirty || !snapshot) setStatus(`v${target.version.number} 자동 저장 후 전체 문서를 분석합니다.`);

      activeRun = {
        id: crypto.randomUUID(), documentId: target.document.id, versionId: target.version.id,
        versionHash: target.version.contentHash, modelId: targetModelId, createdAt: Date.now(), status: 'running', findings: [],
        limitations: [], checkedBlockIds: [], error: ''
      };
      await qaxiomDatabase.analysis_runs.add(activeRun);
      setAnalysisRun(activeRun); setEditorTab('analysis');
      setAnalysisHistory(previous => [activeRun!, ...previous]);

      if (useChunking) {
        // 분할 분석 (Chunking Mode)
        const chunks = await prepareChunkedDocumentAnalysis(target, { focusInstruction: overrideInstruction });
        const subRuns: AnalysisRun[] = [];

        for (let i = 0; i < chunks.length; i++) {
          if (abort.signal.aborted) throw new Error('분석을 취소했습니다.');
          const chunk = chunks[i];
          setStatus(`분할 분석 진행 중 (${i + 1}/${chunks.length} 섹션 검토)...`);

          let response = ''; let failure: Error | null = null;
          await sendChatMessage([{ id: crypto.randomUUID(), role: 'user', content: chunk.requestPrompt, timestamp: Date.now() }], targetModelId,
            'document_analysis', settings, {
              onChunk: c => { response += c; if (response.length > 2_000_000) { failure = new Error('분석 응답이 너무 깁니다.'); abort.abort(); } },
            onError: cause => { failure = cause; }, onFinish: () => { }
          }, abort.signal);

          if (failure) throw failure;
          if (abort.signal.aborted) throw new Error('분석을 취소했습니다.');

          const chunkSnapshot: TheorySnapshot = { ...target, blocks: chunk.blocks };
          const subRun = parseDocumentAnalysis(response, chunkSnapshot, targetModelId);
          subRuns.push(subRun);
        }

        const completed = parseChunkedDocumentAnalysis(subRuns, target, targetModelId);
        completed.id = activeRun.id; completed.createdAt = activeRun.createdAt;
        await qaxiomDatabase.analysis_runs.put(completed);
        setAnalysisRun(completed);
        setAnalysisHistory(previous => previous.map(item => item.id === completed.id ? completed : item));
        setStatus('섹션별 분할 정합성 분석이 성공적으로 완료되었습니다.');
      } else {
        // 일반 통합 분석 (Single Context Mode)
        const request = await prepareDocumentAnalysis(target, { focusInstruction: overrideInstruction });
        let response = ''; let failure: Error | null = null;
        await sendChatMessage([{ id: crypto.randomUUID(), role: 'user', content: request, timestamp: Date.now() }], targetModelId,
          'document_analysis', settings, {
            onChunk: chunk => { response += chunk; if (response.length > 2_000_000) { failure = new Error('분석 응답이 너무 깁니다.'); abort.abort(); } },
          onError: cause => { failure = cause; }, onFinish: () => { }
        }, abort.signal);
        if (failure) throw failure;
        if (abort.signal.aborted) throw new Error('분석을 취소했습니다.');
        const completed = parseDocumentAnalysis(response, target, targetModelId);
        completed.id = activeRun.id; completed.createdAt = activeRun.createdAt;
        await qaxiomDatabase.analysis_runs.put(completed);
        setAnalysisRun(completed);
        setAnalysisHistory(previous => previous.map(item => item.id === completed.id ? completed : item));
        setStatus('전체 문서 정합성 분석이 성공적으로 완료되었습니다.');
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'AI 분석에 실패했습니다.';
      setError(message);
      if (activeRun) {
        const failed: AnalysisRun = { ...activeRun, status: abort.signal.aborted ? 'stopped' : 'failed', error: message };
        await qaxiomDatabase.analysis_runs.put(failed);
        setAnalysisRun(failed);
        setAnalysisHistory(previous => previous.map(item => item.id === failed.id ? failed : item));
      }
    } finally { analysisAbort.current = null; setAnalysisBusy(false); }
  };
  const decideAnalysisFinding = async (finding: AnalysisFinding, decision: AnalysisFinding['decision']) => {
    if (!analysisRun) return;
    try {
      await setAnalysisDecision(analysisRun.id, finding.id, decision);
      setAnalysisRun({ ...analysisRun, findings: analysisRun.findings.map(item => item.id === finding.id ? { ...item, decision } : item) });
      setAnalysisHistory(previous => previous.map(item => item.id === analysisRun.id
        ? { ...item, findings: item.findings.map(value => value.id === finding.id ? { ...value, decision } : value) } : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '분석 의견 상태를 저장하지 못했습니다.'); }
  };
  const applyFinding = (finding: AnalysisFinding) => {
    if (!analysisRun || !snapshot) return;
    try {
      setMarkdown(applyAnalysisSuggestion(markdown, snapshot, analysisRun, finding));
      setEditorTab('write');
      setStatus('수정안을 편집 내용에 반영했습니다. 확인 후 문서를 저장하세요.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '수정안을 적용하지 못했습니다.'); }
  };
  const handleDeleteAnalysis = async (targetRun: AnalysisRun) => {
    try {
      await deleteAnalysisRun(targetRun.id);
      const nextHistory = analysisHistory.filter(item => item.id !== targetRun.id);
      setAnalysisHistory(nextHistory);
      if (analysisRun?.id === targetRun.id) {
        setAnalysisRun(nextHistory[0] ?? null);
      }
      setStatus('분석 결과를 삭제했습니다.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '분석 결과를 삭제하지 못했습니다.'); }
  };
  const comparison = snapshot?.history.find(version => version.id === comparisonId);
  const changes = snapshot && comparison ? compareBlocks(comparisonBlocks, snapshot.blocks).filter(change => change.change !== 'unchanged') : [];
  const analysisViewSnapshot = snapshot && analysisRun?.versionId !== snapshot.version.id
    && historicalAnalysisSnapshot?.version.id === analysisRun?.versionId ? historicalAnalysisSnapshot : snapshot;

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
              className="mobile-menu-btn topbar-tooltip"
              onClick={onOpenMobileMenu}
              data-tooltip="대화 메뉴 열기"
              aria-label="대화 메뉴 열기"
            >
              <Menu size={18} />
            </button>
          )}

          {/* 프로젝트명 칩 (📁 Qaether Theory) */}
          {projectName && (
            <div className="header-project-chip header-project-label" aria-label={`현재 프로젝트: ${projectName}`}>
              <Folder size={13} className="header-project-icon" />
              <span className="header-project-name">{projectName}</span>
            </div>
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
              <button type="submit" className="title-save-btn topbar-tooltip" aria-label="문서 제목 저장" data-tooltip="문서 제목 저장">
                <Check size={14} />
              </button>
              <h2 id="theory-heading" className="sr-only">
                {title.trim() || (snapshot ? snapshot.version.title : '새 연구노트')}
              </h2>
            </form>
          ) : (
            <div className="title-display theory-title-display">
              <h2 id="theory-heading" aria-label={title || '연구노트'}>
                <button
                  ref={titleButtonRef}
                  type="button"
                  className="title-edit-btn theory-title-edit-btn topbar-tooltip"
                  onClick={() => {
                    setTitleDraft(title);
                    setIsEditingTitle(true);
                  }}
                  aria-label={`${title || '연구노트'} 제목 수정`}
                  data-tooltip="문서 제목 수정"
                >
                  <span>{title || '연구노트'}</span>
                  <span className="theory-title-edit-affordance" aria-hidden="true">
                    <Edit3 size={14} strokeWidth={2.4} />
                  </span>
                </button>
              </h2>
            </div>
          )}

          {snapshot && (
            <button
              type="button"
              className="theory-version-chip topbar-tooltip"
              onClick={() => setActiveModal(activeModal === 'history' ? null : 'history')}
              data-tooltip="버전 비교"
              aria-label={`v${snapshot.version.number} 버전 비교`}
              aria-expanded={activeModal === 'history'}
            >
              v{snapshot.version.number}
            </button>
          )}
          {dirty && <span className="theory-dirty-indicator" title="저장되지 않은 변경사항이 있습니다">● 미저장</span>}
        </div>

        <div className="theory-header-actions">
          {(snapshot || markdown.trim()) && (
            <aside className="theory-top-ai-aside" aria-label="AI 분석과 검토 결과">
              <button
                type="button"
                className={`theory-topbar-btn theory-btn-ai topbar-tooltip ${editorTab === 'analysis' ? 'active' : ''}`}
                onClick={() => setActiveModal('analysis')}
                disabled={analysisBusy || busy || loading}
                data-tooltip="AI 분석"
                aria-label="AI로 문서 분석"
              >
                <Sparkles size={16} />
              </button>
            </aside>
          )}

          {snapshot && (
            <button
              type="button"
              className="theory-topbar-btn topbar-tooltip"
              onClick={() => setIsReferenceModalOpen(true)}
              disabled={busy || loading}
              data-tooltip="레퍼런스 추가"
              aria-label="레퍼런스 추가"
              style={{ color: '#fbbf24' }}
            >
              <Paperclip size={16} />
            </button>
          )}

          <button
            type="button"
            className={`theory-topbar-btn topbar-tooltip ${isSearchDrawerOpen ? 'active' : ''}`}
            onClick={() => setIsSearchDrawerOpen(prev => !prev)}
            disabled={busy || loading}
            data-tooltip="통합 검색 (노트내 단어 / 레퍼런스 RAG)"
            aria-label="통합 검색"
            style={{ color: '#38bdf8' }}
          >
            <Search size={16} />
          </button>

          {snapshot && (
            <button
              type="button"
              className={`theory-topbar-btn topbar-tooltip ${isWikiPublished ? 'published' : ''}`}
              onClick={handlePublishToWiki}
              disabled={publishBusy || isWikiPublished || busy || loading}
              data-tooltip={isWikiPublished ? `Wiki 등재됨 (v${snapshot.version.number})` : '이 버전을 Wiki에 등록'}
              aria-label="이 버전을 Wiki에 등록"
              style={isWikiPublished ? { color: '#4ade80' } : { color: '#c084fc' }}
            >
              {isWikiPublished ? <Check size={16} /> : <BookPlus size={16} />}
            </button>
          )}

          {snapshot && (
            <button
              type="button"
              className="theory-topbar-btn theory-btn-criteria topbar-tooltip"
              onClick={() => setActiveModal('contract')}
              disabled={busy || loading}
              data-tooltip="연구 기준"
              aria-label="연구 기준"
            >
              <BookOpen size={16} />
            </button>
          )}

          <button
            type="button"
            className="theory-topbar-btn theory-btn-save topbar-tooltip"
            disabled={!title.trim() || !markdown.trim() || !dirty || busy}
            onClick={() => void save()}
            data-tooltip={snapshot ? '새 버전 저장' : '문서 저장'}
            aria-label={snapshot ? '새 버전 저장' : '문서 저장'}
          >
            <Save size={16} />
          </button>
        </div>
      </header>

      {error && <p role="alert" className="theory-error-banner">{error}</p>}
      {status && <p role="status" className="theory-status-banner">{status}</p>}

      {snapshot && isReferenceModalOpen && (
        <NoteReferencesModal
          isOpen
          onClose={() => setIsReferenceModalOpen(false)}
          documentId={snapshot.document.id}
          version={snapshot.version}
          boundIds={snapshot.version.referenceIds ?? []}
          onSaveBindings={handleUpdateVersionReferenceIds}
        />
      )}

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
            {editorTab === 'preview' && (
              <select
                className="theory-math-renderer-select"
                aria-label="미리보기 수식 렌더러"
                title="미리보기 수식 렌더러"
                value={previewMathRenderer}
                onChange={event => setPreviewMathRenderer(event.target.value as 'mathjax' | 'katex')}
              >
                <option value="mathjax">MathJax</option>
                <option value="katex">KaTeX</option>
              </select>
            )}
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
              {snapshot && (analysisRun || editorTab === 'analysis') && <button
                type="button"
                className={`theory-md-tab ${editorTab === 'analysis' ? 'active' : ''}`}
                onClick={() => setEditorTab('analysis')}
                title="AI 분석 결과"
              >
                <Sparkles size={13} />
                <span>분석</span>
              </button>}
            </div>
          </div>
        </div>

        {/* 순수 편집기 본문: 화면 전체를 채움 */}
        <label htmlFor="theory-markdown" className="sr-only">문서 본문 (Markdown)</label>
        <div className="theory-editor-body vcs-editor-body">
          <textarea
            ref={textareaRef}
            id="theory-markdown"
            className={`theory-markdown-textarea vcs-textarea ${editorTab !== 'write' ? 'hidden' : ''}`}
            value={markdown}
            onChange={event => setMarkdown(event.target.value)}
            onKeyDown={handleEditorKeyDown}
            placeholder="아이디어, 연구 가설, 수식($...$, $$...$$), 설명을 자유롭게 적으세요. Markdown 문법이 지원됩니다."
            aria-label="문서 본문 (Markdown)"
          />
          {editorTab === 'preview' && (
            <div className="theory-markdown-preview-pane vcs-preview-pane">
              <div className="theory-preview-content">
                {markdown.trim() ? (
                  previewMathRenderer === 'mathjax' ? (
                    <Suspense fallback={<p role="status">MathJax 미리보기 준비 중…</p>}>
                      <MathJaxMarkdown content={preprocessLatex(markdown)} />
                    </Suspense>
                  ) : (
                    <ReactMarkdown
                      remarkPlugins={[remarkMath]}
                      rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
                    >
                      {preprocessLatex(markdown)}
                    </ReactMarkdown>
                  )
                ) : (
                  <p className="theory-preview-empty">작성된 마크다운 내용이 없습니다. '편집' 탭에서 본문을 작성하세요.</p>
                )}
              </div>
            </div>
          )}
          {editorTab === 'analysis' && snapshot && <div className="theory-markdown-preview-pane vcs-preview-pane">
            {dirty && <p className="document-analysis-warning">현재 편집 내용은 분석 대상 버전과 다릅니다. 저장 후 AI 분석을 다시 실행하세요.</p>}
            {analysisRun && analysisRun.versionId !== snapshot.version.id && <p className="document-analysis-warning">이전 버전의 분석 결과가 있습니다. 현재 v{snapshot.version.number} 문서를 다시 분석하세요.</p>}
            <DocumentAnalysisView
              snapshot={analysisViewSnapshot ?? snapshot}
              run={analysisRun?.versionId === (analysisViewSnapshot ?? snapshot).version.id ? analysisRun : null}
              history={analysisHistory}
              onSelectHistory={run => setAnalysisRun(run)}
              onDecision={(finding, decision) => { void decideAnalysisFinding(finding, decision); }}
              onApply={applyFinding}
              canApply={(analysisViewSnapshot ?? snapshot).version.id === snapshot.version.id && !dirty}
              onRetry={() => void startAnalysis()}
              onCancel={() => analysisAbort.current?.abort()}
              onDelete={run => void handleDeleteAnalysis(run)}
            />
          </div>}

          <NoteInlineSearchDrawer
            isOpen={isSearchDrawerOpen}
            onClose={() => setIsSearchDrawerOpen(false)}
            version={snapshot?.version}
            markdown={markdown}
            onInsertQuote={handleInsertQuote}
            onSelectNoteLine={handleNavigateToLine}
          />
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
              <div className="theory-modal-title-group">
                {activeModal === 'contract' && <BookOpen size={18} className="theory-modal-title-icon" />}
                {activeModal === 'history' && <Folder size={18} className="theory-modal-title-icon" />}
                {activeModal === 'analysis' && <Sparkles size={18} className="theory-modal-title-icon" />}
                <h3>
                  {activeModal === 'contract' && '연구 기준 (ResearchContract) 설정 및 AI 후보 제안'}
                  {activeModal === 'history' && '문서 버전 비교 및 과거 버전 복원'}
                  {activeModal === 'analysis' && 'AI 문서 정합성 분석 및 검토 설정'}
                </h3>
              </div>
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
              {activeModal === 'contract' && (
                <div className="theory-contract-modal-view">
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

                  <details ref={contractDetails} id="theory-contract-fields" className="theory-contract" open>
                    <summary className="theory-contract-summary">
                      <div className="theory-summary-left">
                        <BookOpen size={16} />
                        <span>수동 연구 기준 입력 (목적 · 가정 · 정의 · 기호 · 범위)</span>
                      </div>
                      <span className="theory-contract-count-badge">6개 항목</span>
                    </summary>
                    <fieldset disabled={busy || loading} className="theory-contract-fieldset">
                      <p className="theory-modal-hint">
                        직접 명시한 연구 기준은 문서 버전과 함께 보존됩니다. 본문의 근거 문단(블록)과 연결하여 논리적 정합성을 더 높일 수 있습니다.
                      </p>
                      <div className="theory-contract-grid">
                        {(Object.keys(contractLabels) as (keyof ResearchContract)[]).map(key => (
                          <div key={key} className="theory-contract-item">
                            <div className="theory-contract-item-header">
                              <label htmlFor={`contract-${key}`}>{contractLabels[key]}</label>
                              {contract[key].trim() ? (
                                <span className="theory-field-status filled">작성됨</span>
                              ) : (
                                <span className="theory-field-status empty">비어있음</span>
                              )}
                            </div>
                            <textarea
                              id={`contract-${key}`}
                              rows={2}
                              placeholder={`${contractLabels[key]} 내용을 입력하세요...`}
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
                                    <option key={block.id} value={block.id}>블록 {block.position + 1} · {block.text.slice(0, 50)}...</option>
                                  ))}
                                </select>
                              </label>
                            )}
                          </div>
                        ))}
                      </div>
                    </fieldset>
                  </details>
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

              {activeModal === 'analysis' && (() => {
                const selectedModelObj = AVAILABLE_MODELS.find(m => m.id === analysisModelId) || AVAILABLE_MODELS[0];
                const modelContextLimit = selectedModelObj.contextWindowTokens || 128000;
                const safePromptLimit = Math.floor(modelContextLimit * 0.85);

                const estimatedDocTokens = estimateTokenCount(markdown);
                const estimatedContractTokens = estimateTokenCount(Object.values(contract).filter(Boolean).join('\n'));
                const estimatedInstructionTokens = estimateTokenCount(analysisCustomInstruction);
                const totalEstimatedTokens = estimatedDocTokens + estimatedContractTokens + estimatedInstructionTokens;

                const tokenUsageRatio = Math.min(100, (totalEstimatedTokens / modelContextLimit) * 100);
                const isOverSafeLimit = totalEstimatedTokens > safePromptLimit;
                const isOverLimit = totalEstimatedTokens > modelContextLimit;

                // 1-Click 추천 모델 찾기 (현재 토큰을 안정적으로 수용 가능한 1M/2M 대용량 모델)
                const recommendedLargeModel = AVAILABLE_MODELS.find(m => (m.contextWindowTokens || 0) >= 1_000_000 && m.id !== analysisModelId);

                return (
                  <div className="theory-analysis-modal-view">
                    <p className="theory-modal-hint">
                      문서 전체의 내부 정합성, 수식 유도, 공리/가정 누락 및 반례 후보를 심층 검토합니다.
                    </p>

                    <div className="theory-analysis-config-section">
                      <div className="theory-analysis-label-row">
                        <label className="theory-analysis-config-label">
                          <Cpu size={15} />
                          <span>분석 모델 및 용량 제한</span>
                        </label>
                        {isOverSafeLimit && (
                          <span className={`theory-token-status-badge ${isOverLimit ? 'critical' : 'warning'}`}>
                            {isOverLimit ? '⚠️ 용량 초과' : '⚡ 권장 한도 경고'}
                          </span>
                        )}
                      </div>
                      <select
                        className={`theory-analysis-model-select ${isOverSafeLimit ? 'warning-border' : ''}`}
                        value={analysisModelId}
                        onChange={e => setAnalysisModelId(e.target.value)}
                      >
                        {AVAILABLE_MODELS.map(model => (
                          <option key={model.id} value={model.id}>
                            {model.name} ({model.provider.toUpperCase()}) — 최대 {formatTokenLimit(model.contextWindowTokens || 128000)}
                          </option>
                        ))}
                      </select>
                      <div className="theory-analysis-token-summary">
                        <span>모델 총 컨텍스트: <strong>{formatTokenLimit(modelContextLimit)}</strong> (권장 안전 입력: <strong>{formatTokenLimit(safePromptLimit)}</strong>)</span>
                      </div>
                    </div>

                    {/* 실시간 토큰 점유율 및 대상 문서 정보 (분석 모델 선택 바로 아래 위치) */}
                    <div className="theory-analysis-context-info">
                      <div className="theory-analysis-info-row">
                        <span>분석 대상 문서:</span>
                        <strong>{title || '(제목 없음)'} {snapshot ? `(v${snapshot.version.number})` : '(초안)'}</strong>
                      </div>
                      <div className="theory-analysis-info-row">
                        <span>분석 범위:</span>
                        <span>전체 {snapshot?.blocks.length ?? 0}개 블록 / 연구 기준 {Object.values(contract).filter(v => v.trim()).length}/6개 포함</span>
                      </div>

                      {/* 토큰 세부 구성 Breakdown */}
                      <div className="theory-token-breakdown-chips">
                        <span className="theory-token-chip">본문 ~{estimatedDocTokens.toLocaleString()} 토큰</span>
                        {estimatedContractTokens > 0 && (
                          <span className="theory-token-chip">연구기준 ~{estimatedContractTokens.toLocaleString()} 토큰</span>
                        )}
                        {estimatedInstructionTokens > 0 && (
                          <span className="theory-token-chip">추가지시 ~{estimatedInstructionTokens.toLocaleString()} 토큰</span>
                        )}
                      </div>

                      <div className="theory-analysis-token-meter-box">
                        <div className="theory-token-meter-header">
                          <span>실시간 예상 컨텍스트 점유율:</span>
                          <strong className={isOverLimit ? 'over-limit' : isOverSafeLimit ? 'warning-limit' : ''}>
                            ~{totalEstimatedTokens.toLocaleString()} / {modelContextLimit.toLocaleString()} 토큰 ({tokenUsageRatio < 0.1 && totalEstimatedTokens > 0 ? '<0.1' : tokenUsageRatio.toFixed(1)}%)
                          </strong>
                        </div>
                        <div className="theory-token-meter-bar">
                          <div
                            className={`theory-token-meter-fill ${isOverLimit ? 'critical' : isOverSafeLimit ? 'warning' : 'normal'}`}
                            style={{ width: `${Math.max(2, Math.min(100, tokenUsageRatio))}%` }}
                          />
                        </div>

                        {isOverSafeLimit && (
                          <div className="theory-token-recommendation-box">
                            <p className="theory-token-warning-text">
                              {isOverLimit
                                ? '⚠️ 문서 및 지시사항의 총 토큰 수가 선택된 모델의 전체 용량을 초과했습니다.'
                                : '💡 AI의 안정적인 정합성 검토 결과 생성을 위해 더 여유로운 대용량 컨텍스트 모델 사용을 권장합니다.'}
                            </p>
                            {recommendedLargeModel && (
                              <button
                                type="button"
                                className="theory-token-switch-btn"
                                onClick={() => setAnalysisModelId(recommendedLargeModel.id)}
                              >
                                ⚡ {recommendedLargeModel.name} ({formatTokenLimit(recommendedLargeModel.contextWindowTokens || 1000000)}) 모델로 1-Click 전환
                              </button>
                            )}
                          </div>
                        )}

                        {/* 분할 분석 (Chunking Mode) 선택 옵션 */}
                        <div className="theory-chunking-option-box">
                          <label className="theory-chunking-toggle-label">
                            <input
                              type="checkbox"
                              checked={isChunkingEnabled}
                              onChange={e => setIsChunkingEnabled(e.target.checked)}
                            />
                            <span>🧩 섹션별 분할 분석 (Chunking Mode) 사용</span>
                          </label>
                          <p className="theory-chunking-hint">
                            문서가 모델의 컨텍스트 용량을 초과하더라도 장/단락 단위로 쪼개어 안전하게 순차 검토합니다. (블록 ID 매핑 및 1-클릭 Diff 100% 보존)
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="theory-analysis-config-section">
                      <label className="theory-analysis-config-label">
                        <Sliders size={15} />
                        <span>검토 포커스 선택</span>
                      </label>
                      <div className="theory-analysis-preset-grid">
                        {ANALYSIS_PRESETS.map(preset => {
                          const isSelected = analysisPreset === preset.id;
                          return (
                            <div
                              key={preset.id}
                              className={`theory-analysis-preset-card ${isSelected ? 'selected' : ''}`}
                              onClick={() => setAnalysisPreset(preset.id)}
                            >
                              <div className="theory-preset-head">
                                <strong>{preset.title}</strong>
                                <span className="theory-preset-badge">{preset.badge}</span>
                              </div>
                              <p className="theory-preset-desc">{preset.desc}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="theory-analysis-config-section">
                      <label className="theory-analysis-config-label">
                        <Edit3 size={15} />
                        <span>연구자 추가 지시사항 (선택)</span>
                      </label>
                      <textarea
                        className="theory-analysis-custom-textarea"
                        rows={3}
                        placeholder="예: 3장의 게이지 대칭성 유도 과정과 공리 2의 타당성을 중점적으로 검토해줘"
                        value={analysisCustomInstruction}
                        onChange={e => setAnalysisCustomInstruction(e.target.value)}
                      />
                    </div>
                  </div>
                );
              })()}

            </div>

            <div className="theory-modal-footer">
              <button
                type="button"
                className="theory-modal-footer-close-btn"
                onClick={() => setActiveModal(null)}
              >
                닫기
              </button>
              {activeModal === 'contract' && (
                <button
                  type="button"
                  className="theory-modal-footer-save-btn"
                  disabled={!title.trim() || !markdown.trim() || !dirty || busy}
                  onClick={() => {
                    void save();
                    setActiveModal(null);
                  }}
                >
                  <Save size={14} />
                  <span>연구 기준 저장</span>
                </button>
              )}
              {activeModal === 'analysis' && (() => {
                const selectedModelObj = AVAILABLE_MODELS.find(m => m.id === analysisModelId) || AVAILABLE_MODELS[0];
                const modelContextLimit = selectedModelObj.contextWindowTokens || 128000;
                const estimatedDocTokens = estimateTokenCount(markdown);
                const estimatedContractTokens = estimateTokenCount(Object.values(contract).filter(Boolean).join('\n'));
                const estimatedInstructionTokens = estimateTokenCount(analysisCustomInstruction);
                const totalEstimatedTokens = estimatedDocTokens + estimatedContractTokens + estimatedInstructionTokens;
                const isOverLimit = totalEstimatedTokens > modelContextLimit;
                const canStart = !isOverLimit || isChunkingEnabled;

                return (
                  <button
                    type="button"
                    className={`theory-modal-footer-save-btn theory-start-analysis-modal-btn ${!canStart ? 'over-limit-btn' : ''}`}
                    disabled={analysisBusy || busy || !title.trim() || !markdown.trim() || !canStart}
                    title={!canStart ? '선택한 모델의 토큰 용량을 초과했습니다. Gemini 모델을 선택하거나 분할 분석 옵션을 켜주세요.' : '정합성 분석 시작'}
                    onClick={() => {
                      if (!canStart) return;
                      const presetObj = ANALYSIS_PRESETS.find(p => p.id === analysisPreset);
                      const combinedInstruction = [
                        presetObj?.instruction,
                        analysisCustomInstruction
                      ].filter(Boolean).join('\n\n');

                      setActiveModal(null);
                      void startAnalysis(analysisModelId, combinedInstruction);
                    }}
                  >
                    <Sparkles size={14} />
                    <span>
                      {isOverLimit && isChunkingEnabled
                        ? '분할 정합성 분석 시작'
                        : isOverLimit
                          ? '용량 초과 (분할 또는 모델 변경 필요)'
                          : '정합성 분석 시작'}
                    </span>
                  </button>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}
