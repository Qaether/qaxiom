import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { qaxiomDatabase } from '../services/database';
import { compareBlocks } from '../services/theory/blocks';
import { createTheory, loadTheory, restoreTheoryVersion, saveTheoryVersion, updateVersionReferenceIds } from '../services/theory/documents';
import { EMPTY_CONTRACT, type ContractAnchors, type DocumentBlock, type ResearchContract, type TheorySnapshot } from '../services/theory/types';
import './TheoryWorkspace.css';
import NoteReferencesModal from './NoteReferencesModal';
import NoteInlineSearchDrawer from './NoteInlineSearchDrawer';
import DocumentAnalysisView from './DocumentAnalysisView';
import type { AnalysisProgress } from './DocumentAnalysisView';
import { preprocessLatex } from './mathMarkdown';
import { applyAnalysisSuggestion, deleteAnalysisRun, parseDocumentAnalysis, prepareDocumentAnalysis, prepareChunkedDocumentAnalysis, parseChunkedDocumentAnalysis, setAnalysisDecision, type AnalysisFinding, type AnalysisRun } from '../services/theory/analysis';
import { sendChatMessage } from '../services/llm';
import ContractSuggestionAssistant from './ContractSuggestionAssistant';
import type { UserSettings } from '../types';
import type { DocumentDraft } from '../services/documentChat';
import { computeLineDiff, groupDiffIntoSegments, resolveDiffHunk, type DiffLine, type DiffStats } from '../services/diffUtils';

import { AVAILABLE_MODELS, estimateTokenCount, formatTokenLimit } from '../constants';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { listWikiPages, publishTheoryToWiki } from '../services/wiki/wikiService';
import {
  Bold, Italic, Heading, Code, Quote, List, Sigma, Eye, Edit3,
  Sparkles, BookOpen, Save, X, Folder, Menu, Check, Cpu, Sliders, BookPlus, Search, Paperclip
} from 'lucide-react';

const MathJaxMarkdown = lazy(() => import('./MathJaxMarkdown'));

const contractLabels: Record<keyof ResearchContract, string> = {
  purpose: 'Purpose', assumptions: 'Assumptions & Axioms', definitions: 'Key Definitions',
  symbols: 'Symbols', scope: 'Scope', openQuestions: 'Open Questions'
};
const changeLabels: Record<string, string> = {
  added: 'Added', changed: 'Changed', removed: 'Removed', moved: 'Moved', unchanged: 'Unchanged'
};

const ANALYSIS_PRESETS = [
  {
    id: 'comprehensive',
    title: 'Comprehensive Consistency Review',
    badge: 'Recommended',
    desc: 'Exhaustively checks claim conflicts, missing assumptions, definition mismatches, reasoning leaps, scope, and counterexample candidates',
    instruction: ''
  },
  {
    id: 'math',
    title: 'Equation Derivation & Symbol Verification',
    badge: 'Math/Physics',
    desc: 'Focuses on operational consistency of derivations, dimensional/index consistency, symbol definitions, and tensor/vector notation',
    instruction: 'Focus on the rigor of equation derivations, dimensional analysis, symbol definition inconsistencies, and LaTeX notation errors.'
  },
  {
    id: 'assumptions',
    title: 'Hidden Assumptions & Counterexamples',
    badge: 'Axioms/Assumptions',
    desc: 'Traces unstated implicit assumptions, boundary-condition blind spots, counterexamples, and edge-case exceptions',
    instruction: 'Focus on identifying unstated implicit assumptions, boundary-condition exceptions in scope, and potential counterexamples.'
  },
  {
    id: 'logic',
    title: 'Logical Leaps & Paragraph Conflicts',
    badge: 'Logical Flow',
    desc: 'Checks logical connections between paragraphs, inferential leaps from premises to conclusions, and conflicting statements',
    instruction: 'Focus on logical connectivity between paragraphs, inferential leaps from premises to conclusions, and conflicting claims in the text.'
  }
];

export interface IncomingDraftAction {
  text: string;
  mode: 'replace' | 'append' | 'diff_review' | 'direct_accept';
  token: number;
}

export interface PendingSuggestion {
  id: string;
  originalText: string;
  proposedText: string;
  diffLines: DiffLine[];
  stats: DiffStats;
}

type ActiveModal = 'contract' | 'history' | 'analysis' | null;

export default function TheoryWorkspace({
  onClose,
  assistantDraft,
  incomingDraft,
  settings,
  modelId,
  initialDocumentId,
  embedded = false,
  projectName,
  onOpenMobileMenu,
  onContextChange,
  onSaved,
  onSuggestionSettled,
}: {
  onClose: () => void;
  assistantDraft?: string;
  incomingDraft?: IncomingDraftAction | null;
  settings: UserSettings;
  modelId: string;
  initialDocumentId?: string | null;
  embedded?: boolean;
  projectName?: string;
  onOpenMobileMenu?: () => void;
  onContextChange?: (draft: DocumentDraft) => void;
  onSaved?: (document: { id: string; title: string; version: number }) => void;
  onNewDocument?: () => void;
  onSuggestionSettled?: (status: 'accepted' | 'rejected') => void;
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
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress | null>(null);
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

  const [pendingSuggestion, setPendingSuggestion] = useState<PendingSuggestion | null>(null);
  const [diffViewMode, setDiffViewMode] = useState<'diff' | 'preview'>('diff');

  const handleAcceptSuggestion = () => {
    if (!pendingSuggestion) return;
    setMarkdown(pendingSuggestion.proposedText);
    setPendingSuggestion(null);
    setStatus('✓ Accepted AI revision and applied it to the document.');
    onSuggestionSettled?.('accepted');
  };

  const handleRejectSuggestion = () => {
    if (!pendingSuggestion) return;
    setPendingSuggestion(null);
    setStatus('✕ Rejected remaining revisions and kept the current text.');
    onSuggestionSettled?.('rejected');
  };

  const handleResolveHunk = (hunkId: string, decision: 'accept' | 'reject') => {
    if (!pendingSuggestion) return;
    const { nextOriginal, nextProposed } = resolveDiffHunk(pendingSuggestion.diffLines, hunkId, decision);
    if (decision === 'accept') {
      setMarkdown(nextOriginal);
    }
    const nextDiff = computeLineDiff(nextOriginal, nextProposed);
    if (nextDiff.stats.added === 0 && nextDiff.stats.removed === 0) {
      setPendingSuggestion(null);
      setStatus('✓ Reviewed and applied all revision suggestions to the document.');
      onSuggestionSettled?.('accepted');
      return;
    }
    setPendingSuggestion({
      ...pendingSuggestion,
      originalText: nextOriginal,
      proposedText: nextProposed,
      diffLines: nextDiff.lines,
      stats: nextDiff.stats,
    });
  };

  // Keyboard shortcuts for accepting/rejecting suggestions
  useEffect(() => {
    if (!pendingSuggestion) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleRejectSuggestion();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleAcceptSuggestion();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pendingSuggestion]);

  useEffect(() => {
    if (!incomingDraft) return;
    const proposed = incomingDraft.text;
    if (incomingDraft.mode === 'direct_accept') {
      setMarkdown(proposed);
      setPendingSuggestion(null);
      setDiffViewMode('preview');
      setStatus('✓ Accepted AI revision and applied it to the document.');
      onSuggestionSettled?.('accepted');
      return;
    }

    if (!markdown.trim() || incomingDraft.mode === 'replace') {
      if (!markdown.trim()) {
        setMarkdown(proposed);
        setStatus('Drafted research note body from chat response.');
        return;
      }
    }
    if (incomingDraft.mode === 'append') {
      setMarkdown(prev => prev.trimEnd() ? `${prev.trimEnd()}\n\n${proposed}` : proposed);
      setPendingSuggestion(null);
      setStatus('✓ Appended selected content to the end of the research note.');
      return;
    }

    // Default or diff_review: enter Cursor-style inline diff review mode
    const diffResult = computeLineDiff(markdown, proposed);
    setPendingSuggestion({
      id: String(incomingDraft.token),
      originalText: markdown,
      proposedText: proposed,
      diffLines: diffResult.lines,
      stats: diffResult.stats,
    });
    setDiffViewMode('diff');
    setEditorTab('write');
    setStatus('✦ AI revision suggestions arrived. Accept or reject in the top bar.');
  }, [incomingDraft]);

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
      setStatus('Current version published to Wiki archive.');
    } catch {
      setStatus('Failed to publish to Wiki.');
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

  const confirmDiscard = () => !dirty || window.confirm('Discard unsaved document changes?');
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
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Failed to open document.'); })
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
          const stopped: AnalysisRun = { ...item, status: 'stopped', error: 'Previous analysis run ended. It will not be automatically re-sent.' };
          await qaxiomDatabase.analysis_runs.put(stopped);
          return stopped;
        }));
        if (active && !analysisAbort.current) { setAnalysisHistory(restored); setAnalysisRun(restored[0] ?? null); }
      })
      .catch(() => { if (active) setError('Failed to load analysis history.'); });
    return () => { active = false; };
  }, [analysisDocumentId]);
  useEffect(() => {
    if (!analysisRun || !snapshot || analysisRun.versionId === snapshot.version.id) return;
    let active = true;
    void Promise.all([qaxiomDatabase.document_versions.get(analysisRun.versionId),
    qaxiomDatabase.document_blocks.where('versionId').equals(analysisRun.versionId).sortBy('position')])
      .then(([version, blocks]) => {
        if (active && version?.documentId === snapshot.document.id) setHistoricalAnalysisSnapshot({ ...snapshot, version, blocks });
      }).catch(() => { if (active) setError('Failed to load document version for previous analysis.'); });
    return () => { active = false; };
  }, [analysisRun, snapshot]);
  useEffect(() => () => { analysisAbort.current?.abort(); }, []);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setStatus('');
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Document operation failed.'); }
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
    setStatus(`Saved v${saved.version.number}. Previous versions are preserved.`);
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
    const quoteMarkdown = `\n\n> "${quoteText}"\n> — *Source: ${sourceName}${locationStr ? ` (${locationStr})` : ''}*\n\n`;
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
    setAnalysisProgress(null);
    try {
      if (!title.trim() || !markdown.trim()) throw new Error('Please enter a document title and body.');
      const target = dirty || !snapshot ? await persistDraft() : snapshot;
      if (dirty || !snapshot) setStatus(`Auto-saved v${target.version.number}; analyzing full document.`);

      activeRun = {
        id: crypto.randomUUID(), documentId: target.document.id, versionId: target.version.id,
        versionHash: target.version.contentHash, modelId: targetModelId, createdAt: Date.now(), status: 'running', findings: [],
        limitations: [], checkedBlockIds: [], error: ''
      };
      await qaxiomDatabase.analysis_runs.add(activeRun);
      setAnalysisRun(activeRun); setEditorTab('analysis');
      setAnalysisProgress({ runId: activeRun.id, stage: 'Preparing analysis request', startedAt: Date.now(), receivedChars: 0, reasoningSummary: '' });
      setAnalysisHistory(previous => [activeRun!, ...previous]);

      const updateProgress = (changes: Partial<AnalysisProgress>) => {
        setAnalysisProgress(previous => previous && previous.runId === activeRun?.id ? { ...previous, ...changes } : previous);
      };
      const appendReasoningSummary = (chunk: string) => {
        setAnalysisProgress(previous => previous && previous.runId === activeRun?.id
          ? {
            ...previous,
            reasoningSummary: (previous.reasoningSummary + chunk).slice(-20_000),
            summaryTruncated: previous.summaryTruncated || previous.reasoningSummary.length + chunk.length > 20_000
          }
          : previous);
      };

      if (useChunking) {
        // Chunked Analysis (Chunking Mode)
        const chunks = await prepareChunkedDocumentAnalysis(target, { focusInstruction: overrideInstruction });
        const subRuns: AnalysisRun[] = [];
        let receivedTotal = 0;

        for (let i = 0; i < chunks.length; i++) {
          if (abort.signal.aborted) throw new Error('Analysis was canceled.');
          const chunk = chunks[i];
          updateProgress({ stage: `Waiting for model response · Section ${i + 1}/${chunks.length}` });

          let response = ''; let failure: Error | null = null; let reportedChars = 0;
          await sendChatMessage([{ id: crypto.randomUUID(), role: 'user', content: chunk.requestPrompt, timestamp: Date.now() }], targetModelId,
            'document_analysis', settings, {
              onChunk: c => {
                response += c;
                if (reportedChars === 0 || response.length - reportedChars >= 2048) {
                  reportedChars = response.length;
                  updateProgress({ stage: `Receiving results · Section ${i + 1}/${chunks.length}`, receivedChars: receivedTotal + response.length });
                }
                if (response.length > 2_000_000) { failure = new Error('Analysis response is too long.'); abort.abort(); }
              },
              onReasoningSummary: appendReasoningSummary,
              onError: cause => { failure = cause; }, onFinish: () => { }
          }, abort.signal);

          if (failure) throw failure;
          if (abort.signal.aborted) throw new Error('Analysis was canceled.');

          updateProgress({ stage: `Validating response · Section ${i + 1}/${chunks.length}` });
          const chunkSnapshot: TheorySnapshot = { ...target, blocks: chunk.blocks };
          const subRun = parseDocumentAnalysis(response, chunkSnapshot, targetModelId);
          subRuns.push(subRun);
          receivedTotal += response.length;
          updateProgress({ receivedChars: receivedTotal });
        }

        const completed = parseChunkedDocumentAnalysis(subRuns, target, targetModelId);
        completed.id = activeRun.id; completed.createdAt = activeRun.createdAt;
        await qaxiomDatabase.analysis_runs.put(completed);
        setAnalysisRun(completed);
        updateProgress({ stage: 'Analysis complete' });
        setAnalysisHistory(previous => previous.map(item => item.id === completed.id ? completed : item));
        setStatus('Sectioned consistency analysis completed successfully.');
      } else {
        // Unified Single-Context Analysis (Single Context Mode)
        const request = await prepareDocumentAnalysis(target, { focusInstruction: overrideInstruction });
        updateProgress({ stage: 'Waiting for model response' });
        let response = ''; let failure: Error | null = null; let reportedChars = 0;
        await sendChatMessage([{ id: crypto.randomUUID(), role: 'user', content: request, timestamp: Date.now() }], targetModelId,
          'document_analysis', settings, {
            onChunk: chunk => {
              response += chunk;
              if (reportedChars === 0 || response.length - reportedChars >= 2048) {
                reportedChars = response.length;
                updateProgress({ stage: 'Receiving results', receivedChars: response.length });
              }
              if (response.length > 2_000_000) { failure = new Error('Analysis response is too long.'); abort.abort(); }
            },
            onReasoningSummary: appendReasoningSummary,
            onError: cause => { failure = cause; }, onFinish: () => { }
        }, abort.signal);
        if (failure) throw failure;
        if (abort.signal.aborted) throw new Error('Analysis was canceled.');
        updateProgress({ stage: 'Validating response', receivedChars: response.length });
        const completed = parseDocumentAnalysis(response, target, targetModelId);
        completed.id = activeRun.id; completed.createdAt = activeRun.createdAt;
        await qaxiomDatabase.analysis_runs.put(completed);
        setAnalysisRun(completed);
        updateProgress({ stage: 'Analysis complete' });
        setAnalysisHistory(previous => previous.map(item => item.id === completed.id ? completed : item));
        setStatus('Full-document consistency analysis completed successfully.');
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'AI analysis failed.';
      setError(message);
      if (activeRun) {
        const failed: AnalysisRun = { ...activeRun, status: abort.signal.aborted ? 'stopped' : 'failed', error: message };
        setAnalysisProgress(previous => previous?.runId === failed.id ? { ...previous, stage: failed.status === 'stopped' ? 'Analysis canceled' : 'Analysis failed' } : previous);
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to save finding decision.'); }
  };
  const applyFinding = (finding: AnalysisFinding) => {
    if (!analysisRun || !snapshot) return;
    try {
      setMarkdown(applyAnalysisSuggestion(markdown, snapshot, analysisRun, finding));
      setEditorTab('write');
      setStatus('Applied suggestion to draft. Review and save the document.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to apply suggestion.'); }
  };
  const handleDeleteAnalysis = async (targetRun: AnalysisRun) => {
    try {
      await deleteAnalysisRun(targetRun.id);
      const nextHistory = analysisHistory.filter(item => item.id !== targetRun.id);
      setAnalysisHistory(nextHistory);
      if (analysisRun?.id === targetRun.id) {
        setAnalysisRun(nextHistory[0] ?? null);
      }
      setStatus('Deleted analysis result.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to delete analysis result.'); }
  };
  const comparison = snapshot?.history.find(version => version.id === comparisonId);
  const changes = snapshot && comparison ? compareBlocks(comparisonBlocks, snapshot.blocks).filter(change => change.change !== 'unchanged') : [];
  const analysisViewSnapshot = snapshot && analysisRun?.versionId !== snapshot.version.id
    && historicalAnalysisSnapshot?.version.id === analysisRun?.versionId ? historicalAnalysisSnapshot : snapshot;

  return (
    <dialog ref={dialog} className={`theory-workspace ${embedded ? 'embedded' : ''}`} aria-labelledby="theory-heading"
      onCancel={event => { event.preventDefault(); close(); }}>
      {/* 1. Top bar: unified header bar (project chip + inline title editor + action buttons) */}
      <header className="theory-header">
        <div className="theory-header-meta">
          {onOpenMobileMenu && (
            <button
              type="button"
              id="mobile-menu-btn"
              className="mobile-menu-btn topbar-tooltip"
              onClick={onOpenMobileMenu}
              data-tooltip="Open chat menu"
              aria-label="Open chat menu"
            >
              <Menu size={18} />
            </button>
          )}

          {/* Project name chip */}
          {projectName && (
            <div className="header-project-chip header-project-label" aria-label={`Current project: ${projectName}`}>
              <Folder size={13} className="header-project-icon" />
              <span className="header-project-name">{projectName}</span>
            </div>
          )}

          {/* Document title display/edit area */}
          {(!snapshot || isEditingTitle) ? (
            <form onSubmit={handleTitleSubmit} className="title-edit-form theory-title-edit-form">
              <label htmlFor="theory-title" className="sr-only">Document title</label>
              <input
                id="theory-title"
                className="title-edit-input theory-title-edit-input"
                aria-label="Document title"
                value={isEditingTitle ? titleDraft : title}
                onChange={e => {
                  setTitleDraft(e.target.value);
                  setTitle(e.target.value);
                }}
                placeholder="Enter document title"
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
              <button type="submit" className="title-save-btn topbar-tooltip" aria-label="Save document title" data-tooltip="Save document title">
                <Check size={14} />
              </button>
              <h2 id="theory-heading" className="sr-only">
                {title.trim() || (snapshot ? snapshot.version.title : 'New Research Note')}
              </h2>
            </form>
          ) : (
            <div className="title-display theory-title-display">
              <h2 id="theory-heading" aria-label={title || 'Research Note'}>
                <button
                  ref={titleButtonRef}
                  type="button"
                  className="title-edit-btn theory-title-edit-btn topbar-tooltip"
                  onClick={() => {
                    setTitleDraft(title);
                    setIsEditingTitle(true);
                  }}
                  aria-label={`Edit title for ${title || 'Research Note'}`}
                  data-tooltip="Edit document title"
                >
                  <span>{title || 'Research Note'}</span>
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
              data-tooltip="Compare versions"
              aria-label={`Compare version v${snapshot.version.number}`}
              aria-expanded={activeModal === 'history'}
            >
              v{snapshot.version.number}
            </button>
          )}
          {dirty && <span className="theory-dirty-indicator" title="Unsaved changes">● Unsaved</span>}
        </div>

        <div className="theory-header-actions">
          {(snapshot || markdown.trim()) && (
            <aside className="theory-top-ai-aside" aria-label="AI analysis and review results">
              <button
                type="button"
                className={`theory-topbar-btn theory-btn-ai topbar-tooltip ${editorTab === 'analysis' ? 'active' : ''}`}
                onClick={() => setActiveModal('analysis')}
                disabled={analysisBusy || busy || loading}
                data-tooltip="AI Analysis"
                aria-label="Analyze document with AI"
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
              data-tooltip="Add reference"
              aria-label="Add reference"
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
            data-tooltip="Search (in-note terms / reference RAG)"
            aria-label="Search"
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
              data-tooltip={isWikiPublished ? `Published to Wiki (v${snapshot.version.number})` : 'Publish this version to Wiki'}
              aria-label="Publish this version to Wiki"
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
              data-tooltip="Research Criteria"
              aria-label="Research Criteria"
            >
              <BookOpen size={16} />
            </button>
          )}

          <button
            type="button"
            className="theory-topbar-btn theory-btn-save topbar-tooltip"
            disabled={!title.trim() || !markdown.trim() || !dirty || busy}
            onClick={() => void save()}
            data-tooltip={snapshot ? 'Save new version' : 'Save document'}
            aria-label={snapshot ? 'Save new version' : 'Save document'}
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

      {/* 2. Editor Body: VCS-style Fullscreen Markdown Editor */}
      <div className="theory-editor-container vcs-mode" aria-busy={busy || loading}>
        <div className="theory-editor-toolbar-bar">
          <div className="theory-editor-toolbar-left">
            {!snapshot && (
              <div className="theory-editor-step-label">
                <h3>1. Write Document</h3>
              </div>
            )}

            {editorTab === 'write' && (
              <div className="theory-md-toolbar-actions">
                <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('### ', '', 'Heading')} title="Heading 3 (###)" aria-label="Heading"><Heading size={13} /></button>
                <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('**', '**', 'bold')} title="Bold (**text**)" aria-label="Bold"><Bold size={13} /></button>
                <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('*', '*', 'italic')} title="Italic (*text*)" aria-label="Italic"><Italic size={13} /></button>
                <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('$', '$', 'x')} title="Inline math ($x$)" aria-label="Inline math"><Sigma size={13} /></button>
                <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('```\n', '\n```', 'code')} title="Code block" aria-label="Code block"><Code size={13} /></button>
                <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('> ', '', 'quote')} title="Blockquote (>)" aria-label="Blockquote"><Quote size={13} /></button>
                <button type="button" className="theory-md-btn" onClick={() => insertMarkdown('- ', '', 'item')} title="Bullet list (-)" aria-label="Bullet list"><List size={13} /></button>
              </div>
            )}
          </div>

          <div className="theory-editor-actions-bar">
            {editorTab === 'preview' && (
              <select
                className="theory-math-renderer-select"
                aria-label="Preview math renderer"
                title="Preview math renderer"
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
                title="Markdown edit mode"
              >
                <Edit3 size={13} />
                <span>Edit</span>
              </button>
              <button
                type="button"
                className={`theory-md-tab ${editorTab === 'preview' ? 'active' : ''}`}
                onClick={() => setEditorTab('preview')}
                title="Markdown rendered preview mode"
              >
                <Eye size={13} />
                <span>Preview</span>
              </button>
              {snapshot && (analysisRun || editorTab === 'analysis') && <button
                type="button"
                className={`theory-md-tab ${editorTab === 'analysis' ? 'active' : ''}`}
                onClick={() => setEditorTab('analysis')}
                title="AI analysis results"
              >
                <Sparkles size={13} />
                <span>Analysis</span>
              </button>}
            </div>
          </div>
        </div>

        {/* Editor body: fills the viewport */}
        <label htmlFor="theory-markdown" className="sr-only">Document body (Markdown)</label>
        <div className="theory-editor-body vcs-editor-body">
          {pendingSuggestion && editorTab === 'write' ? (
            <div className="theory-inline-diff-container">
              {/* Floating Review Action Bar */}
              <div className="theory-review-floating-bar" role="region" aria-label="Review AI revision suggestions">
                <div className="theory-review-bar-info">
                  <span className="theory-review-sparkle">✦</span>
                  <span className="theory-review-title">Review AI Revision Suggestions</span>
                  <span className="theory-diff-stat-badge added">+{pendingSuggestion.stats.added} lines</span>
                  <span className="theory-diff-stat-badge removed">-{pendingSuggestion.stats.removed} lines</span>
                  <span className="theory-diff-stat-badge hunks">
                    {groupDiffIntoSegments(pendingSuggestion.diffLines).filter(s => s.kind === 'hunk').length} remaining change(s)
                  </span>
                </div>
                <div className="theory-review-bar-actions">
                  <button
                    type="button"
                    className="theory-review-btn-toggle"
                    onClick={() => setDiffViewMode(m => m === 'diff' ? 'preview' : 'diff')}
                    title="Toggle between Diff view and Result preview"
                  >
                    {diffViewMode === 'diff' ? 'Preview Result' : 'View Diff'}
                  </button>
                  <button
                    type="button"
                    className="theory-review-btn-reject"
                    onClick={handleRejectSuggestion}
                    title="Reject all remaining suggestions (Esc)"
                    aria-label="Reject All (Esc)"
                  >
                    <X size={14} />
                    <span>Reject All (Esc)</span>
                  </button>
                  <button
                    type="button"
                    className="theory-review-btn-accept"
                    onClick={handleAcceptSuggestion}
                    title="Accept all remaining suggestions (⌘+Enter)"
                    aria-label="Accept All (Cmd+Enter)"
                  >
                    <Check size={14} />
                    <span>Accept All (⌘↵)</span>
                  </button>
                </div>
              </div>

              {/* Diff or Preview View */}
              {diffViewMode === 'diff' ? (
                <div className="theory-inline-diff-viewer">
                  <div className="theory-diff-lines-wrapper">
                    {groupDiffIntoSegments(pendingSuggestion.diffLines).map((segment, segIdx) => {
                      if (segment.kind === 'unchanged') {
                        return segment.lines.map((line, lineIdx) => (
                          <div key={`u-${segIdx}-${lineIdx}`} className="theory-diff-line-row unchanged">
                            <span className="theory-diff-line-num old">{line.oldLineNumber}</span>
                            <span className="theory-diff-line-num new">{line.newLineNumber}</span>
                            <span className="theory-diff-line-sign"> </span>
                            <span className="theory-diff-line-text">{line.text || ' '}</span>
                          </div>
                        ));
                      }
                      const { hunk } = segment;
                      return (
                        <div key={hunk.id} className="theory-diff-hunk-group" data-hunk-id={hunk.id}>
                          <div className="theory-diff-hunk-bar">
                            <span className="theory-diff-hunk-label">
                              Change #{hunk.index + 1}
                              {hunk.addedCount > 0 && <span className="theory-diff-hunk-count added"> +{hunk.addedCount}</span>}
                              {hunk.removedCount > 0 && <span className="theory-diff-hunk-count removed"> -{hunk.removedCount}</span>}
                            </span>
                            <div className="theory-diff-hunk-actions">
                              <button
                                type="button"
                                className="theory-diff-hunk-btn reject"
                                aria-label={`Reject change ${hunk.index + 1}`}
                                onClick={() => handleResolveHunk(hunk.id, 'reject')}
                              >
                                <X size={12} />
                                <span>Reject</span>
                              </button>
                              <button
                                type="button"
                                className="theory-diff-hunk-btn accept"
                                aria-label={`Accept change ${hunk.index + 1}`}
                                onClick={() => handleResolveHunk(hunk.id, 'accept')}
                              >
                                <Check size={12} />
                                <span>Accept</span>
                              </button>
                            </div>
                          </div>
                          {hunk.lines.map((line, lineIdx) => (
                            <div key={`${hunk.id}-${lineIdx}`} className={`theory-diff-line-row ${line.type}`}>
                              <span className="theory-diff-line-num old">
                                {line.type === 'removed' ? line.oldLineNumber : ''}
                              </span>
                              <span className="theory-diff-line-num new">
                                {line.type === 'added' ? line.newLineNumber : ''}
                              </span>
                              <span className="theory-diff-line-sign">
                                {line.type === 'added' ? '+' : '-'}
                              </span>
                              <span className="theory-diff-line-text">{line.text || ' '}</span>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="theory-markdown-preview-pane vcs-preview-pane">
                  <div className="theory-preview-content">
                    <ReactMarkdown
                      remarkPlugins={[remarkMath, remarkGfm]}
                      rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
                    >
                      {preprocessLatex(pendingSuggestion.proposedText)}
                    </ReactMarkdown>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              id="theory-markdown"
              className={`theory-markdown-textarea vcs-textarea ${editorTab !== 'write' ? 'hidden' : ''}`}
              value={markdown}
              onChange={event => setMarkdown(event.target.value)}
              onKeyDown={handleEditorKeyDown}
              placeholder="Write ideas, research hypotheses, equations ($...$, $$...$$), and explanations freely. Markdown is supported."
              aria-label="Document body (Markdown)"
            />
          )}
          {editorTab === 'preview' && (
            <div className="theory-markdown-preview-pane vcs-preview-pane">
              <div className="theory-preview-content">
                {markdown.trim() ? (
                  previewMathRenderer === 'mathjax' ? (
                    <Suspense fallback={<p role="status">Preparing MathJax preview…</p>}>
                      <MathJaxMarkdown content={preprocessLatex(markdown)} />
                    </Suspense>
                  ) : (
                    <ReactMarkdown
                      remarkPlugins={[remarkMath, remarkGfm]}
                      rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
                    >
                      {preprocessLatex(markdown)}
                    </ReactMarkdown>
                  )
                ) : (
                  <p className="theory-preview-empty">No Markdown content yet. Write your document in the &ldquo;Edit&rdquo; tab.</p>
                )}
              </div>
            </div>
          )}
          {editorTab === 'analysis' && snapshot && <div className="theory-markdown-preview-pane vcs-preview-pane">
            {dirty && <p className="document-analysis-warning">Current edits differ from the analyzed version. Save and re-run AI analysis.</p>}
            {analysisRun && analysisRun.versionId !== snapshot.version.id && <p className="document-analysis-warning">Analysis results are from a previous version. Re-analyze the current v{snapshot.version.number} document.</p>}
            <DocumentAnalysisView
              snapshot={analysisViewSnapshot ?? snapshot}
              run={analysisRun?.versionId === (analysisViewSnapshot ?? snapshot).version.id ? analysisRun : null}
              history={analysisHistory}
              progress={analysisProgress}
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

        {/* Minimal editor footer bar */}
        <div className="theory-editor-footer-bar">
          <div className="theory-footer-stats">
            <span>{markdown.length} chars</span>
            <span>·</span>
            <span>{markdown ? markdown.split('\n').length : 0} lines</span>
            {dirty && <span className="theory-footer-dirty">● Unsaved changes</span>}
          </div>

          {assistantDraft && !pendingSuggestion && (
            <button
              type="button"
              className="theory-btn-draft-import"
              onClick={() => {
                if (!markdown.trim()) {
                  setMarkdown(assistantDraft);
                  setStatus('Imported latest chat response into the document.');
                  return;
                }
                const diffResult = computeLineDiff(markdown, assistantDraft);
                setPendingSuggestion({
                  id: String(Date.now()),
                  originalText: markdown,
                  proposedText: assistantDraft,
                  diffLines: diffResult.lines,
                  stats: diffResult.stats,
                });
                setDiffViewMode('diff');
                setEditorTab('write');
                setStatus('✦ Reviewing changes from latest chat response.');
              }}
            >
              Review changes from latest chat response
            </button>
          )}
        </div>
      </div>

      {/* 3. Analysis / Tool Modal Dialog */}
      {activeModal && (
        <div className="theory-modal-backdrop" onClick={() => setActiveModal(null)}>
          <div className="theory-modal-container" onClick={e => e.stopPropagation()}>
            <div className="theory-modal-header">
              <div className="theory-modal-title-group">
                {activeModal === 'contract' && <BookOpen size={18} className="theory-modal-title-icon" />}
                {activeModal === 'history' && <Folder size={18} className="theory-modal-title-icon" />}
                {activeModal === 'analysis' && <Sparkles size={18} className="theory-modal-title-icon" />}
                <h3>
                  {activeModal === 'contract' && 'Research Criteria (ResearchContract) & AI Suggestions'}
                  {activeModal === 'history' && 'Compare Versions & Restore Past Version'}
                  {activeModal === 'analysis' && 'AI Consistency Analysis & Review Settings'}
                </h3>
              </div>
              <button
                type="button"
                className="theory-modal-close-btn"
                onClick={() => setActiveModal(null)}
                title="Close"
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
                      setStatus(`Populated ${keys.length} research criteria candidate(s). Review and save the document.`);
                    }}
                  />

                  <details ref={contractDetails} id="theory-contract-fields" className="theory-contract" open>
                    <summary className="theory-contract-summary">
                      <div className="theory-summary-left">
                        <BookOpen size={16} />
                        <span>Manual Research Criteria (Purpose · Assumptions · Definitions · Symbols · Scope)</span>
                      </div>
                      <span className="theory-contract-count-badge">6 items</span>
                    </summary>
                    <fieldset disabled={busy || loading} className="theory-contract-fieldset">
                      <p className="theory-modal-hint">
                        Explicitly defined research criteria are preserved with the document version. Link them to source paragraphs (blocks) to strengthen logical traceability.
                      </p>
                      <div className="theory-contract-grid">
                        {(Object.keys(contractLabels) as (keyof ResearchContract)[]).map(key => (
                          <div key={key} className="theory-contract-item">
                            <div className="theory-contract-item-header">
                              <label htmlFor={`contract-${key}`}>{contractLabels[key]}</label>
                              {contract[key].trim() ? (
                                <span className="theory-field-status filled">Filled</span>
                              ) : (
                                <span className="theory-field-status empty">Empty</span>
                              )}
                            </div>
                            <textarea
                              id={`contract-${key}`}
                              rows={2}
                              placeholder={`Enter ${contractLabels[key]}...`}
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
                                <span>Link evidence block:</span>
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
                                  <option value="">No link</option>
                                  {snapshot.blocks.map(block => (
                                    <option key={block.id} value={block.id}>Block {block.position + 1} · {block.text.slice(0, 50)}...</option>
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
                <section className="theory-history" aria-label="Compare versions">
                  <p className="theory-modal-hint">Select a past version to view changes compared to the currently saved v{snapshot.version.number}.</p>
                  <select
                    aria-label="Version to compare"
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
                    <option value="">Select version to compare</option>
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
                          if (!confirmDiscard() || !window.confirm(`Restore v${comparison.number} as a new version? All past versions will be preserved.`)) return;
                          void run(async () => {
                            const saved = await restoreTheoryVersion(snapshot.document.id, snapshot.version.id, comparison.id);
                            adopt(saved);
                            setStatus(`Restored to v${saved.version.number}.`);
                            setActiveModal(null);
                          });
                        }}
                      >
                        Restore this version
                      </button>
                      {comparison.title !== snapshot.version.title && (
                        <p className="theory-diff-title-change">Title changed: {comparison.title} → {snapshot.version.title}</p>
                      )}
                      {(Object.keys(contractLabels) as (keyof ResearchContract)[]).filter(key => comparison.contract[key] !== snapshot.version.contract[key]).map(key => (
                        <div className="theory-change" key={key}>
                          <strong>{contractLabels[key]} changed</strong>
                          <div className="theory-diff"><pre>{comparison.contract[key] || '(None)'}</pre><pre>{snapshot.version.contract[key] || '(None)'}</pre></div>
                        </div>
                      ))}
                      <p className="theory-diff-count-label">{changes.length} body change(s) · Left: Past / Right: Current</p>
                      {changes.map(change => (
                        <div key={change.id} className="theory-change">
                          <strong>{changeLabels[change.change]}</strong>
                          <div className="theory-diff"><pre>{change.before || '(None)'}</pre><pre>{change.after || '(None)'}</pre></div>
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

                // 1-Click recommended model (1M/2M large-context model that safely fits current tokens)
                const recommendedLargeModel = AVAILABLE_MODELS.find(m => (m.contextWindowTokens || 0) >= 1_000_000 && m.id !== analysisModelId);

                return (
                  <div className="theory-analysis-modal-view">
                    <p className="theory-modal-hint">
                      Performs a deep review of internal consistency, equation derivations, missing axioms/assumptions, and counterexample candidates across the entire document.
                    </p>

                    <div className="theory-analysis-config-section">
                      <div className="theory-analysis-label-row">
                        <label className="theory-analysis-config-label">
                          <Cpu size={15} />
                          <span>Analysis Model &amp; Context Limit</span>
                        </label>
                        {isOverSafeLimit && (
                          <span className={`theory-token-status-badge ${isOverLimit ? 'critical' : 'warning'}`}>
                            {isOverLimit ? '⚠️ Over Limit' : '⚡ Recommended Limit Warning'}
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
                            {model.name} ({model.provider.toUpperCase()}) — Max {formatTokenLimit(model.contextWindowTokens || 128000)}
                          </option>
                        ))}
                      </select>
                      <div className="theory-analysis-token-summary">
                        <span>Total Model Context: <strong>{formatTokenLimit(modelContextLimit)}</strong> (Recommended Safe Input: <strong>{formatTokenLimit(safePromptLimit)}</strong>)</span>
                      </div>
                    </div>

                    {/* Real-time token usage and target document info */}
                    <div className="theory-analysis-context-info">
                      <div className="theory-analysis-info-row">
                        <span>Target Document:</span>
                        <strong>{title || '(Untitled)'} {snapshot ? `(v${snapshot.version.number})` : '(Draft)'}</strong>
                      </div>
                      <div className="theory-analysis-info-row">
                        <span>Analysis Scope:</span>
                        <span>All {snapshot?.blocks.length ?? 0} block(s) / {Object.values(contract).filter(v => v.trim()).length}/6 criteria included</span>
                      </div>

                      {/* Token Breakdown */}
                      <div className="theory-token-breakdown-chips">
                        <span className="theory-token-chip">Body ~{estimatedDocTokens.toLocaleString()} tokens</span>
                        {estimatedContractTokens > 0 && (
                          <span className="theory-token-chip">Criteria ~{estimatedContractTokens.toLocaleString()} tokens</span>
                        )}
                        {estimatedInstructionTokens > 0 && (
                          <span className="theory-token-chip">Instructions ~{estimatedInstructionTokens.toLocaleString()} tokens</span>
                        )}
                      </div>

                      <div className="theory-analysis-token-meter-box">
                        <div className="theory-token-meter-header">
                          <span>Estimated Context Usage:</span>
                          <strong className={isOverLimit ? 'over-limit' : isOverSafeLimit ? 'warning-limit' : ''}>
                            ~{totalEstimatedTokens.toLocaleString()} / {modelContextLimit.toLocaleString()} tokens ({tokenUsageRatio < 0.1 && totalEstimatedTokens > 0 ? '<0.1' : tokenUsageRatio.toFixed(1)}%)
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
                                ? '⚠️ Total tokens for the document and instructions exceed the selected model\'s capacity.'
                                : '💡 A larger-context model is recommended for reliable AI consistency review.'}
                            </p>
                            {recommendedLargeModel && (
                              <button
                                type="button"
                                className="theory-token-switch-btn"
                                onClick={() => setAnalysisModelId(recommendedLargeModel.id)}
                              >
                                ⚡ 1-Click switch to {recommendedLargeModel.name} ({formatTokenLimit(recommendedLargeModel.contextWindowTokens || 1000000)})
                              </button>
                            )}
                          </div>
                        )}

                        {/* Chunking Mode Option */}
                        <div className="theory-chunking-option-box">
                          <label className="theory-chunking-toggle-label">
                            <input
                              type="checkbox"
                              checked={isChunkingEnabled}
                              onChange={e => setIsChunkingEnabled(e.target.checked)}
                            />
                            <span>🧩 Use Section-by-Section Analysis (Chunking Mode)</span>
                          </label>
                          <p className="theory-chunking-hint">
                            Even if the document exceeds the model&apos;s context limit, it is safely reviewed sequentially by chapter/section. (Preserves 100% block ID mapping and 1-click Diffs.)
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="theory-analysis-config-section">
                      <label className="theory-analysis-config-label">
                        <Sliders size={15} />
                        <span>Select Review Focus</span>
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
                        <span>Additional Researcher Instructions (Optional)</span>
                      </label>
                      <textarea
                        className="theory-analysis-custom-textarea"
                        rows={3}
                        placeholder="e.g., Focus on the gauge symmetry derivation in Section 3 and the validity of Axiom 2"
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
                Close
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
                  <span>Save Research Criteria</span>
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
                    title={!canStart ? 'Exceeds the selected model\'s token capacity. Choose a Gemini model or enable Chunking Mode.' : 'Start Consistency Analysis'}
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
                        ? 'Start Chunked Consistency Analysis'
                        : isOverLimit
                          ? 'Over Limit (Enable Chunking or Switch Model)'
                          : 'Start Consistency Analysis'}
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
