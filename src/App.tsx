import React, { useState, useEffect, useRef } from 'react';
import { FileText, Plus, Folder, Menu, MessageSquare, Trash2, X, History } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import ProjectStart, { type OpenedProject } from './components/ProjectStart';
import './components/ProjectStart.css';
import { ChatPanelHeader } from './components/ChatPanelHeader';
import { ChatInput } from './components/ChatInput';
import { EmptyState } from './components/EmptyState';
import { SettingsModal } from './components/SettingsModal';
import { chooseWorkspaceDirectory, writeTheoryDocumentsToDirectory, writeWorkspaceBackupToDirectory } from './services/folderExport';
import type { ChatSession, UserSettings, ResearchMode } from './types';
import { saveSessions, createNewSession, loadSettings, saveSettings } from './services/storage';
import { sendChatMessage } from './services/llm';
import { AVAILABLE_MODELS, resolveModelId } from './constants';
import {
  appendAssistantChunk,
  createAssistantMessage,
  createUserMessage,
  getRetryContext,
  settleAssistantMessage
} from './services/chatState';
import { flushSessionWrites, loadSessionsFromDatabase } from './services/database';
import { listTheories, loadTheory } from './services/theory/documents';
import { deleteTheory, prepareTheoryDeletion, type TheoryDeletionPreview } from './services/theory/theoryDeletion';
import { folderPermission, getActiveProjectFolder, listRecentProjectFolders, rememberProjectFolder, requestFolderPermission } from './services/projectFolder';
import type { ContextBundle, ContextEvidence } from './services/retrieval/types';
import { withReferenceContext } from './services/retrieval/context';
import { captureDocumentContext, sessionsForDocument, verifyDocumentContext, withDocumentContext, type DocumentDraft } from './services/documentChat';
import { classifyChatRoute, internalLightModel, LIGHT_CHAT_MODELS } from './services/chatRouting';
import {
  createWorkspaceBundle,
  restoreWorkspaceBundle,
  serializeWorkspaceBundle
} from './services/workspace';

const ChatMessage = React.lazy(() => import('./components/ChatMessage'));
const TheoryWorkspace = React.lazy(() => import('./components/TheoryWorkspace'));
const ReferenceLibrary = React.lazy(() => import('./components/ReferenceLibrary'));
const ReferenceSource = React.lazy(() => import('./components/ReferenceSource'));

function findAvailableModel(apiKeys: Record<string, string>) {
  const hasProviderKey = (provider: string) => Boolean((apiKeys[provider] || '').trim());
  return AVAILABLE_MODELS.find(model => model.status === 'active' && hasProviderKey(model.provider))
    || AVAILABLE_MODELS.find(model => hasProviderKey(model.provider));
}

interface InitialAppState {
  sessions: ChatSession[];
  currentSessionId: string;
  settings: UserSettings;
  isSettingsOpen: boolean;
}

function createInitialAppState(initialSessions: ChatSession[] = []): InitialAppState {
  const settings = loadSettings();
  const loaded = initialSessions;
  const firstActiveModel = findAvailableModel(settings.apiKeys);

  const sessions = loaded.length > 0
    ? loaded.map(session => {
        const selectedModel = resolveModelId(session.selectedModel);
        const currentModel = AVAILABLE_MODELS.find(model => model.id === selectedModel);
        const hasKey = currentModel
          && Boolean((settings.apiKeys[currentModel.provider as keyof typeof settings.apiKeys] || '').trim());

        return !hasKey && firstActiveModel
          ? { ...session, selectedModel: firstActiveModel.id }
          : { ...session, selectedModel };
      })
    : [createNewSession(
        settings.defaultMode,
        firstActiveModel?.id || settings.defaultModel
      )];

  return {
    sessions,
    currentSessionId: sessions[0].id,
    settings,
    isSettingsOpen: false
  };
}

interface AppProps {
  initialSessions?: ChatSession[];
  initialStorageWarning?: string;
}

function getStorageErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return '브라우저 저장 공간이 부족해 대화를 저장하지 못했습니다. 불필요한 데이터를 정리하거나 대화를 내보내 주세요.';
  }
  return '대화를 브라우저 저장소에 기록하지 못했습니다. 사생활 보호 모드 또는 브라우저 저장소 설정을 확인해 주세요.';
}

export const App: React.FC<AppProps> = ({ initialSessions, initialStorageWarning }) => {
  const [initialState] = useState(() => createInitialAppState(initialSessions));
  const [sessions, setSessions] = useState<ChatSession[]>(initialState.sessions);
  const [currentSessionId, setCurrentSessionId] = useState(initialState.currentSessionId);
  const [settings, setSettings] = useState<UserSettings>(initialState.settings);
  const [isSettingsOpen, setIsSettingsOpen] = useState(initialState.isSettingsOpen);
  const [isStreaming, setIsStreaming] = useState(false);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [isTheoryOpen, setIsTheoryOpen] = useState(false);
  const [openedProject, setOpenedProject] = useState<OpenedProject | null>(null);
  const [rememberedProject, setRememberedProject] = useState<OpenedProject | null>(null);
  const [recentProjects, setRecentProjects] = useState<OpenedProject[]>([]);
  const [projectLoading, setProjectLoading] = useState(true);
  const [projectLoadError, setProjectLoadError] = useState('');
  const [theoryDocumentId, setTheoryDocumentId] = useState<string | null>(null);
  const [documentDraft, setDocumentDraft] = useState<DocumentDraft | null>(null);
  const [newDocumentToken, setNewDocumentToken] = useState(0);
  const [theoryDocuments, setTheoryDocuments] = useState<{ id: string; title: string; version: number }[]>([]);
  const [isReferencesOpen, setIsReferencesOpen] = useState(false);
  const [sourceEvidence, setSourceEvidence] = useState<ContextEvidence | null>(null);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('qaxiom_sidebar_width');
      if (saved) {
        const val = parseInt(saved, 10);
        if (!isNaN(val) && val >= 180 && val <= 480) return val;
      }
    } catch {}
    return 260;
  });

  const [chatWidth, setChatWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('qaxiom_chat_width');
      if (saved) {
        const val = parseInt(saved, 10);
        if (!isNaN(val) && val >= 280 && val <= 650) return val;
      }
    } catch {}
    return 380;
  });

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null);
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const deleteDialogCancelRef = useRef<HTMLButtonElement>(null);
  const deleteDialogTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [pendingDeleteDocumentId, setPendingDeleteDocumentId] = useState<string | null>(null);
  const [documentDeletePreview, setDocumentDeletePreview] = useState<TheoryDeletionPreview | null>(null);
  const [documentDeleteError, setDocumentDeleteError] = useState('');
  const [isPreparingDocumentDelete, setIsPreparingDocumentDelete] = useState(false);
  const [isDeletingDocument, setIsDeletingDocument] = useState(false);
  const documentDeleteCancelRef = useRef<HTMLButtonElement>(null);
  const documentDeleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const routingRef = useRef(false);

  useEffect(() => {
    if (pendingDeleteSessionId) deleteDialogCancelRef.current?.focus();
  }, [pendingDeleteSessionId]);

  useEffect(() => {
    if (!pendingDeleteDocumentId) return;
    let active = true;
    documentDeleteCancelRef.current?.focus();
    if (documentDraft?.dirty && documentDraft.documentId === pendingDeleteDocumentId || isStreaming) return;
    void (async () => {
      await flushSessionWrites();
      const snapshot = await loadTheory(pendingDeleteDocumentId);
      const preview = await prepareTheoryDeletion(pendingDeleteDocumentId, snapshot.version.id);
      if (active) setDocumentDeletePreview(preview);
    })().catch(cause => {
      if (active) setDocumentDeleteError(cause instanceof Error ? cause.message : '문서 삭제 범위를 확인하지 못했습니다.');
    }).finally(() => { if (active) setIsPreparingDocumentDelete(false); });
    return () => { active = false; };
  }, [pendingDeleteDocumentId, documentDraft?.dirty, documentDraft?.documentId, isStreaming]);

  const handleLeftResizerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    document.body.classList.add('resizing-col');

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(180, Math.min(480, moveEvent.clientX));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      document.body.classList.remove('resizing-col');
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      const finalWidth = Math.max(180, Math.min(480, upEvent.clientX));
      try {
        localStorage.setItem('qaxiom_sidebar_width', String(finalWidth));
      } catch {}
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleRightResizerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    document.body.classList.add('resizing-col');

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(280, Math.min(650, window.innerWidth - moveEvent.clientX));
      setChatWidth(newWidth);
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      document.body.classList.remove('resizing-col');
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      const finalWidth = Math.max(280, Math.min(650, window.innerWidth - upEvent.clientX));
      try {
        localStorage.setItem('qaxiom_chat_width', String(finalWidth));
      } catch {}
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const closeMobileSidebar = () => {
    if (!isMobileSidebarOpen) return;
    setIsMobileSidebarOpen(false);
    requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
  };

  const abortControllerRef = useRef<AbortController | null>(null);
  const activeStreamRef = useRef<{ sessionId: string; messageId: string } | null>(null);
  const stoppedMessageIdsRef = useRef(new Set<string>());
  const deletingSessionRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const refreshRecentProjects = async () => {
    try {
      const records = await listRecentProjectFolders();
      setRecentProjects(records.map(r => ({ name: r.name, folderName: r.folderName, directory: r.directory })));
    } catch {
      // fallback
    }
  };

  useEffect(() => {
    let active = true;
    void Promise.all([
      getActiveProjectFolder(),
      listRecentProjectFolders()
    ]).then(async ([activeRecord, recentRecords]) => {
      if (!active) return;
      if (recentRecords && recentRecords.length > 0) {
        setRecentProjects(recentRecords.map(r => ({ name: r.name, folderName: r.folderName, directory: r.directory })));
      }
      if (!activeRecord) return;
      const project = { name: activeRecord.name, folderName: activeRecord.folderName, directory: activeRecord.directory };
      const permission = await folderPermission(activeRecord.directory);
      if (!active) return;
      if (permission === 'granted') setOpenedProject(project);
      else setRememberedProject(project);
    }).catch(cause => {
      if (active) setProjectLoadError(cause instanceof Error ? cause.message : '프로젝트 폴더를 불러오지 못했습니다.');
    }).finally(() => { if (active) setProjectLoading(false); });
    return () => { active = false; };
  }, []);

  // Save sessions whenever they change
  useEffect(() => {
    let active = true;
    if (openedProject && sessions.length > 0) {
      void saveSessions(sessions)
        .then(() => {
          if (active) setPersistenceError(null);
        })
        .catch(error => {
          console.error('세션 저장 실패:', error);
          if (active) setPersistenceError(getStorageErrorMessage(error));
        });
    }
    return () => {
      active = false;
    };
  }, [sessions, openedProject]);

  useEffect(() => {
    if (!openedProject) return;
    let active = true;
    void listTheories().then(rows => {
      if (!active) return;
      const docs = rows.map(row => ({ id: row.document.id, title: row.version.title, version: row.version.number }));
      setTheoryDocuments(docs);

      // Auto-open last worked document or recent document in center pane
      if (docs.length > 0) {
        setTheoryDocumentId(prev => {
          if (prev && docs.some(d => d.id === prev)) return prev;
          let lastId: string | null = null;
          try {
            lastId = localStorage.getItem('qaxiom_last_open_document_id');
          } catch {}
          const target = (lastId && docs.find(d => d.id === lastId)) || docs[0];
          return target.id;
        });
        setIsTheoryOpen(true);
      }
    }).catch(() => {
      if (active) setPersistenceError('연구 문서 목록을 읽지 못했습니다.');
    });
    return () => { active = false; };
  }, [openedProject, isTheoryOpen]);

  useEffect(() => {
    if (!openedProject || !theoryDocumentId) return;
    const scoped = sessionsForDocument(sessions, theoryDocumentId);
    if (scoped.some(session => session.id === currentSessionId)) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (scoped.length) { setCurrentSessionId(scoped[0].id); return; }
      const created = createNewSession(settings.defaultMode, settings.defaultModel, theoryDocumentId);
      setSessions(previous => previous.some(session => session.documentId === theoryDocumentId)
        ? previous : [created, ...previous]);
      setCurrentSessionId(created.id);
    });
    return () => { active = false; };
  }, [openedProject, theoryDocumentId, sessions, currentSessionId, settings.defaultMode, settings.defaultModel]);

  // Scroll to bottom on new message
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [sessions, isStreaming]);

  const visibleSessions = sessionsForDocument(sessions, theoryDocumentId);
  const currentSession = visibleSessions.find(session => session.id === currentSessionId) || visibleSessions[0];

  const handleModeChange = (newMode: ResearchMode) => {
    setSessions(prev => prev.map(s => s.id === currentSession?.id ? { ...s, researchMode: newMode, updatedAt: Date.now() } : s));
  };

  // Create new chat session
  const handleNewSession = () => {
    if (deletingSessionRef.current) return;
    if (isStreaming) handleStopStreaming();
    const newSession = createNewSession(currentSession?.researchMode || settings.defaultMode, currentSession?.selectedModel || settings.defaultModel, theoryDocumentId);
    setSessions(prev => [newSession, ...prev]);
    setCurrentSessionId(newSession.id);
    setIsHistoryOpen(false);
    setTimeout(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.chat-input-textarea');
      if (textarea) {
        textarea.focus();
      }
    }, 50);
  };

  // Select session
  const handleSelectSession = (id: string) => {
    if (deletingSessionRef.current) return;
    if (!visibleSessions.some(session => session.id === id)) return;
    if (isStreaming) handleStopStreaming();
    setCurrentSessionId(id);
  };

  const closeDeleteSessionDialog = () => {
    if (isDeletingSession) return;
    setPendingDeleteSessionId(null);
    requestAnimationFrame(() => deleteDialogTriggerRef.current?.focus());
  };

  const requestDeleteSession = (id: string, trigger: HTMLButtonElement) => {
    if (deletingSessionRef.current) return;
    if (isStreaming) { window.alert('응답 생성이 끝난 뒤 세션을 삭제해 주세요.'); return; }
    const target = visibleSessions.find(session => session.id === id);
    if (!target) return;
    deleteDialogTriggerRef.current = trigger;
    setPendingDeleteSessionId(id);
  };

  // Delete session after an explicit in-app confirmation.
  const handleDeleteSession = async () => {
    if (!pendingDeleteSessionId || deletingSessionRef.current) return;
    const id = pendingDeleteSessionId;
    const target = sessions.find(session => session.id === id);
    if (!target) { setPendingDeleteSessionId(null); return; }
    deletingSessionRef.current = true;
    setIsDeletingSession(true);
    const filtered = sessions.length <= 1
      ? [createNewSession(settings.defaultMode, settings.defaultModel, theoryDocumentId)]
      : sessions.filter(session => session.id !== id);
    try {
      await saveSessions(filtered);
      setSessions(filtered);
      if (currentSessionId === id) setCurrentSessionId(filtered.find(session => session.documentId === theoryDocumentId)?.id ?? '');
      setPersistenceError(null);
      setPendingDeleteSessionId(null);
    } catch (error) {
      setPersistenceError(`세션 삭제를 저장하지 못했습니다. ${getStorageErrorMessage(error)}`);
    } finally {
      deletingSessionRef.current = false;
      setIsDeletingSession(false);
    }
  };

  const closeDeleteDocumentDialog = () => {
    if (isDeletingDocument) return;
    setPendingDeleteDocumentId(null);
    requestAnimationFrame(() => documentDeleteTriggerRef.current?.focus());
  };

  const requestDeleteDocument = (id: string, trigger: HTMLButtonElement) => {
    if (isDeletingDocument || !theoryDocuments.some(row => row.id === id)) return;
    documentDeleteTriggerRef.current = trigger;
    const reason = documentDraft?.dirty && documentDraft.documentId === id
      ? '현재 문서에 저장되지 않은 변경사항이 있습니다. 먼저 저장하거나 변경사항을 버린 뒤 삭제하세요.'
      : isStreaming ? '응답 생성이 끝난 뒤 문서를 삭제해 주세요.' : '';
    setDocumentDeletePreview(null);
    setDocumentDeleteError(reason);
    setIsPreparingDocumentDelete(!reason);
    setPendingDeleteDocumentId(id);
  };

  const handleDeleteDocument = async () => {
    if (!documentDeletePreview || isDeletingDocument || isPreparingDocumentDelete) return;
    if (isStreaming || documentDraft?.dirty && documentDraft.documentId === documentDeletePreview.documentId) {
      setDocumentDeleteError('응답 생성 또는 미저장 문서 수정이 끝난 뒤 다시 시도하세요.');
      return;
    }
    const preview = documentDeletePreview;
    setIsDeletingDocument(true);
    setDocumentDeleteError('');
    try {
      await flushSessionWrites();
      await deleteTheory(preview);
      const nextId = theoryDocumentId === preview.documentId
        ? theoryDocuments.find(row => row.id !== preview.documentId)?.id ?? null
        : theoryDocumentId;
      const remainingSessions = sessions.filter(session => session.documentId !== preview.documentId);
      const nextSessions = remainingSessions.length ? remainingSessions
        : [createNewSession(settings.defaultMode, settings.defaultModel, nextId)];
      setSessions(nextSessions);
      setCurrentSessionId(nextSessions.find(session => session.documentId === nextId)?.id ?? '');
      setTheoryDocuments(previous => previous.filter(row => row.id !== preview.documentId));
      if (theoryDocumentId === preview.documentId) {
        setTheoryDocumentId(nextId);
        setIsTheoryOpen(Boolean(nextId));
        setNewDocumentToken(previous => previous + 1);
        setDocumentDraft(null);
      }
      try {
        if (nextId) localStorage.setItem('qaxiom_last_open_document_id', nextId);
        else localStorage.removeItem('qaxiom_last_open_document_id');
      } catch {}
      setPendingDeleteDocumentId(null);
      setPersistenceError(null);
      requestAnimationFrame(() => {
        const next = document.querySelector<HTMLButtonElement>('.sidebar-document');
        (next ?? document.getElementById('new-theory-btn'))?.focus();
      });
    } catch (cause) {
      setDocumentDeleteError(cause instanceof Error ? cause.message : '문서를 삭제하지 못했습니다.');
    } finally {
      setIsDeletingDocument(false);
    }
  };

  // Update title
  const handleUpdateTitle = (newTitle: string) => {
    if (deletingSessionRef.current) return;
    setSessions(prev =>
      prev.map(s => (s.id === currentSession?.id ? { ...s, title: newTitle, updatedAt: Date.now() } : s))
    );
  };

  // Change model for current session
  const handleModelChange = (modelId: string) => {
    if (deletingSessionRef.current) return;
    setSessions(prev =>
      prev.map(s => (s.id === currentSession?.id ? { ...s, selectedModel: modelId } : s))
    );
  };

  // Stop streaming
  const handleStopStreaming = () => {
    const activeStream = activeStreamRef.current;
    if (activeStream) {
      stoppedMessageIdsRef.current.add(activeStream.messageId);
      setSessions(prev => prev.map(session => {
        if (session.id !== activeStream.sessionId) return session;
        return {
          ...session,
          messages: session.messages.map(message =>
            message.id === activeStream.messageId
              ? settleAssistantMessage(message, { type: 'stop' })
              : message
          )
        };
      }));
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  // Send message
  const handleSendMessage = async (
    userPrompt: string,
    options?: { retryAssistantMessageId?: string; contextBundle?: ContextBundle }
  ) => {
    if (!currentSession || isStreaming || routingRef.current || deletingSessionRef.current) return;
    if (!theoryDocumentId || currentSession.documentId !== theoryDocumentId) return;

    const retryContext = options?.retryAssistantMessageId
      ? getRetryContext(currentSession.messages, options.retryAssistantMessageId)
      : null;
    if (options?.retryAssistantMessageId && !retryContext) return;

    // Check if the required API key for the selected model exists
    const currentModelId = currentSession.selectedModel;
    let model = AVAILABLE_MODELS.find(m => m.id === currentModelId) || AVAILABLE_MODELS[0];
    let providerKey = model.provider as keyof typeof settings.apiKeys;
    let apiKey = (settings.apiKeys[providerKey] || '').trim();

    if (!apiKey) {
      if (options?.contextBundle || (options?.retryAssistantMessageId && currentSession.messages.find(message => message.id === options.retryAssistantMessageId)?.contextBundle)) { setIsSettingsOpen(true); return; }
      // Smart Fallback: Check if user has registered a key for any other provider (e.g. OpenAI)
      const alternativeModel = findAvailableModel(settings.apiKeys);

      if (alternativeModel) {
        // Automatically switch current session to the available model
        handleModelChange(alternativeModel.id);
        model = alternativeModel;
        providerKey = alternativeModel.provider as keyof typeof settings.apiKeys;
        apiKey = (settings.apiKeys[providerKey] || '').trim();
      } else {
        // No keys at all -> Open settings modal cleanly
        setIsSettingsOpen(true);
        return;
      }
    }

    const contextBundle = options?.contextBundle || (options?.retryAssistantMessageId
      ? currentSession.messages.find(message => message.id === options.retryAssistantMessageId)?.contextBundle : undefined);
    const priorAnswer = options?.retryAssistantMessageId
      ? currentSession.messages.find(message => message.id === options.retryAssistantMessageId) : undefined;
    routingRef.current = true;
    let route: 'light' | 'research';
    try {
      route = contextBundle || currentSession.researchMode !== 'general' ? 'research'
        : priorAnswer ? internalLightModel(priorAnswer.model ?? '') ? 'light' : 'research'
          : await classifyChatRoute(userPrompt, model.provider, apiKey);
    } finally {
      routingRef.current = false;
    }
    const responseModel = route === 'light' ? LIGHT_CHAT_MODELS[model.provider] ?? model : model;
    const assistantMessage = createAssistantMessage(responseModel.name, currentSession.researchMode);
    if (contextBundle) assistantMessage.contextBundle = contextBundle;
    const assistantMessageId = assistantMessage.id;

    // Auto title if first message
    const isFirstMessage = currentSession.messages.length === 0;
    const sessionTitle = isFirstMessage
      ? userPrompt.slice(0, 24).replace(/\n/g, ' ') + (userPrompt.length > 24 ? '...' : '')
      : currentSession.title;

    const updatedMessages = retryContext
      ? retryContext.history
      : [...currentSession.messages, createUserMessage(userPrompt)];

    let documentContext;
    try {
      if (route === 'research') {
        if (documentDraft?.documentId !== theoryDocumentId) throw new Error('기준 연구문서를 불러오는 중입니다. 잠시 후 다시 질문해 주세요.');
        const prior = priorAnswer?.documentContext;
        if (prior && prior.documentId !== theoryDocumentId) throw new Error('재시도할 답변의 기준 연구문서가 현재 문서와 다릅니다.');
        documentContext = prior ?? await captureDocumentContext(theoryDocumentId, documentDraft);
        await verifyDocumentContext(documentContext);
        if (contextBundle?.assembly?.research && contextBundle.assembly.research.documentId !== theoryDocumentId)
          throw new Error('선택한 검색 문맥의 연구문서가 현재 문서와 다릅니다.');
        withDocumentContext(contextBundle ? withReferenceContext(updatedMessages, contextBundle) : updatedMessages, documentContext);
      }
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : '연구문서 문맥을 확인하지 못했습니다.');
      return;
    }
    if (documentContext) assistantMessage.documentContext = documentContext;

    // Optimistically update session
    setSessions(prev =>
      prev.map(s =>
        s.id === currentSession.id
          ? {
              ...s,
              title: sessionTitle,
              selectedModel: model.id,
              updatedAt: Date.now(),
              messages: [...updatedMessages, assistantMessage]
            }
          : s
      )
    );

    setIsStreaming(true);
    abortControllerRef.current = new AbortController();
    activeStreamRef.current = { sessionId: currentSession.id, messageId: assistantMessageId };

    await sendChatMessage(
      route === 'light' ? [updatedMessages.at(-1)!] : updatedMessages,
      responseModel.id,
      currentSession.researchMode,
      settings,
      {
        onChunk: (chunk: string) => {
          if (stoppedMessageIdsRef.current.has(assistantMessageId)) return;
          setSessions(prev =>
            prev.map(s => {
              if (s.id !== currentSession.id) return s;
              return {
                ...s,
                messages: s.messages.map(m =>
                  m.id === assistantMessageId
                    ? appendAssistantChunk(m, chunk)
                    : m
                )
              };
            })
          );
        },
        onError: (err: Error) => {
          if (activeStreamRef.current?.messageId === assistantMessageId) {
            setIsStreaming(false);
            activeStreamRef.current = null;
            abortControllerRef.current = null;
          }
          setSessions(prev =>
            prev.map(s => {
              if (s.id !== currentSession.id) return s;
              return {
                ...s,
                messages: s.messages.map(m =>
                  m.id === assistantMessageId
                    ? settleAssistantMessage(m, { type: 'error', message: err.message })
                    : m
                )
              };
            })
          );
        },
        onFinish: () => {
          const wasStopped = stoppedMessageIdsRef.current.delete(assistantMessageId);
          if (activeStreamRef.current?.messageId === assistantMessageId) {
            setIsStreaming(false);
            activeStreamRef.current = null;
            abortControllerRef.current = null;
          }
          setSessions(prev =>
            prev.map(s => {
              if (s.id !== currentSession.id) return s;
              return {
                ...s,
                messages: s.messages.map(m =>
                  m.id === assistantMessageId
                    ? settleAssistantMessage(m, { type: wasStopped ? 'stop' : 'finish' })
                    : m
                )
              };
            })
          );
        }
      },
      abortControllerRef.current.signal,
      route === 'research' ? contextBundle : undefined,
      route === 'research' ? documentContext : undefined
    );
  };

  const handleRetryMessage = (assistantMessageId: string) => {
    if (!currentSession || isStreaming) return;
    const retryContext = getRetryContext(currentSession.messages, assistantMessageId);
    if (!retryContext) return;
    void handleSendMessage(retryContext.prompt, { retryAssistantMessageId: assistantMessageId });
  };

  const handleSaveSettings = (newSettings: UserSettings) => {
    setSettings(newSettings);
    saveSettings(newSettings);

    // If current session's model has no key, auto-switch to a model that has an active key
    const currentModel = AVAILABLE_MODELS.find(m => m.id === currentSession?.selectedModel);
    const currentProvider = currentModel?.provider as keyof typeof newSettings.apiKeys;
    const hasCurrentKey = currentProvider && Boolean(newSettings.apiKeys[currentProvider]?.trim());

    if (!hasCurrentKey) {
      const activeModel = findAvailableModel(newSettings.apiKeys);
      if (activeModel) {
        handleModelChange(activeModel.id);
      }
    }
  };

  const handleExportWorkspace = async () => {
    if (deletingSessionRef.current) throw new Error('세션 삭제 저장이 끝난 뒤 백업해 주세요.');
    if (isStreaming) throw new Error('응답 생성이 끝난 뒤 작업공간을 백업해 주세요.');
    await saveSessions(sessions);
    const bundle = await createWorkspaceBundle();
    const blob = new Blob([serializeWorkspaceBundle(bundle)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `qaxiom-workspace-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleExportWorkspaceToFolder = async (): Promise<string> => {
    if (deletingSessionRef.current) throw new Error('세션 삭제 저장이 끝난 뒤 백업해 주세요.');
    if (isStreaming) throw new Error('응답 생성이 끝난 뒤 작업공간을 백업해 주세요.');
    // The picker must be opened directly from the click before asynchronous database work.
    const directory = await chooseWorkspaceDirectory();
    await saveSessions(sessions);
    const bundle = await createWorkspaceBundle();
    return writeWorkspaceBackupToDirectory(directory, serializeWorkspaceBundle(bundle));
  };

  const handleExportTheoryToFolder = async (): Promise<{ folderName: string; documentCount: number }> => {
    if (deletingSessionRef.current) throw new Error('세션 삭제 저장이 끝난 뒤 내보내 주세요.');
    if (isStreaming) throw new Error('응답 생성이 끝난 뒤 연구 문서를 내보내 주세요.');
    const directory = await chooseWorkspaceDirectory();
    await saveSessions(sessions);
    const bundle = await createWorkspaceBundle();
    return writeTheoryDocumentsToDirectory(directory, bundle);
  };

  const handleRestoreWorkspace = async (file: File): Promise<number> => {
    if (deletingSessionRef.current) throw new Error('세션 삭제 저장이 끝난 뒤 복원해 주세요.');
    if (isStreaming) throw new Error('응답 생성이 끝난 뒤 작업공간을 복원해 주세요.');
    if (file.size > 100 * 1024 * 1024) {
      throw new Error('백업 파일은 100 MB 이하여야 합니다.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      throw new Error('올바른 JSON 백업 파일이 아닙니다.');
    }

    await saveSessions(sessions);
    await restoreWorkspaceBundle(parsed);
    let restoredSessions = await loadSessionsFromDatabase();
    if (restoredSessions.length === 0) {
      restoredSessions = [createNewSession(settings.defaultMode, settings.defaultModel)];
      await saveSessions(restoredSessions);
    }
    setSessions(restoredSessions);
    setCurrentSessionId(restoredSessions[0].id);
    return restoredSessions.length;
  };

  if (projectLoading) return <main className="project-start" role="status">프로젝트 연결 확인 중…</main>;

  if (!openedProject) return <ProjectStart
    remembered={rememberedProject}
    projects={recentProjects}
    initialError={projectLoadError}
    onOpen={async project => {
      await rememberProjectFolder(project);
      await refreshRecentProjects();
      setRememberedProject(project);
      setProjectLoadError('');
      setOpenedProject(project);
    }}
    onSelectProject={async project => {
      if (!await requestFolderPermission(project.directory)) {
        throw new Error('폴더 접근 권한이 없어 프로젝트를 열 수 없습니다. 다시 허용하거나 다른 폴더를 지정해 주세요.');
      }
      await rememberProjectFolder(project);
      await refreshRecentProjects();
      setOpenedProject(project);
    }}
    onReconnect={async () => {
      if (!rememberedProject || !await requestFolderPermission(rememberedProject.directory)) {
        throw new Error('폴더 접근 권한이 없어 프로젝트를 열 수 없습니다. 다시 허용하거나 다른 폴더를 지정해 주세요.');
      }
      await rememberProjectFolder(rememberedProject);
      await refreshRecentProjects();
      setOpenedProject(rememberedProject);
    }} />;

  return (
    <div className="app-container">
      {/* 3-Pane VCS Workspace */}
      <div className="workspace-split-container">
        {isMobileSidebarOpen && <button type="button" className="mobile-sidebar-backdrop" aria-hidden="true" tabIndex={-1} onClick={closeMobileSidebar} />}

        {/* Pane 1: Left Explorer Sidebar */}
        <Sidebar
          projectName={openedProject.name}
          documents={theoryDocuments}
          onOpenDocument={id => {
            setTheoryDocumentId(id);
            setIsTheoryOpen(true);
            try {
              localStorage.setItem('qaxiom_last_open_document_id', id);
            } catch {}
            closeMobileSidebar();
          }}
          onDeleteDocument={requestDeleteDocument}
          onChangeProject={() => { setRememberedProject(openedProject); setOpenedProject(null); closeMobileSidebar(); }}
          onOpenTheory={() => { if (isMobileSidebarOpen) mobileMenuButtonRef.current?.focus(); setNewDocumentToken(previous => previous + 1); setTheoryDocumentId(null); setIsTheoryOpen(true); setIsMobileSidebarOpen(false); }}
          onOpenReferences={() => { if (isMobileSidebarOpen) mobileMenuButtonRef.current?.focus(); setIsReferencesOpen(true); setIsMobileSidebarOpen(false); }}
          onOpenSettings={() => setIsSettingsOpen(true)}
          mobileOpen={isMobileSidebarOpen}
          onCloseMobile={closeMobileSidebar}
          width={sidebarWidth}
        />

        {/* Left Resizer */}
        <div
          className="pane-resizer pane-resizer-left"
          onMouseDown={handleLeftResizerMouseDown}
          onDoubleClick={() => setSidebarWidth(260)}
          title="좌우로 드래그하여 탐색기 너비 조절 (더블클릭 시 260px 초기화)"
          role="separator"
          aria-orientation="vertical"
          aria-label="탐색기 사이드바 너비 조절"
        />

        {/* Pane 2: Center Research Document Editor */}
        <main className="center-document-pane">
          {/* Center Pane Content */}
          {isTheoryOpen || theoryDocumentId ? (
            <React.Suspense fallback={<div className="pane-loading" role="status">연구 문서 불러오는 중…</div>}>
              <TheoryWorkspace
                key={newDocumentToken}
                onClose={() => { setIsTheoryOpen(false); setTheoryDocumentId(null); }}
                initialDocumentId={theoryDocumentId}
                settings={settings}
                modelId={currentSession?.selectedModel || settings.defaultModel}
                assistantDraft={currentSession?.messages.findLast(message => message.role === 'assistant' && message.status === 'complete')?.content}
                embedded={true}
                projectName={openedProject.name}
                onOpenMobileMenu={() => setIsMobileSidebarOpen(true)}
                onContextChange={setDocumentDraft}
                onSaved={document => {
                  setTheoryDocumentId(document.id);
                  setTheoryDocuments(previous => previous.some(row => row.id === document.id)
                    ? previous.map(row => row.id === document.id ? document : row) : [...previous, document]);
                }}
                onNewDocument={() => { setNewDocumentToken(previous => previous + 1); setTheoryDocumentId(null); setIsTheoryOpen(true); }}
              />
            </React.Suspense>
          ) : (
            <>
              {/* Center Pane Header (When No Document Open) */}
              <div className="center-document-header">
                <div className="center-header-left">
                  <button
                    ref={mobileMenuButtonRef}
                    type="button"
                    id="mobile-menu-btn"
                    className="mobile-menu-btn topbar-tooltip"
                    onClick={() => setIsMobileSidebarOpen(true)}
                    data-tooltip="대화 메뉴 열기"
                    aria-label="대화 메뉴 열기"
                    aria-expanded={isMobileSidebarOpen}
                    aria-controls="chat-sidebar"
                  >
                    <Menu size={18} />
                  </button>

                  <div className="header-project-chip header-project-label" aria-label={`현재 프로젝트: ${openedProject.name}`}>
                    <Folder size={13} className="header-project-icon" />
                    <span className="header-project-name">{openedProject.name}</span>
                  </div>
                </div>

                <div className="center-header-right">
                  <button
                    type="button"
                    className="center-header-new-btn topbar-tooltip"
                    onClick={() => { setTheoryDocumentId(null); setIsTheoryOpen(true); }}
                    data-tooltip="새 문서"
                    aria-label="새 문서 작성"
                  >
                    <Plus size={14} />
                    <span>새 문서</span>
                  </button>
                </div>
              </div>

              <div className="center-empty-state">
                <div className="center-empty-card">
                  <div className="center-empty-icon">
                    <FileText size={40} />
                  </div>
                  <h3 className="center-empty-title">열려 있는 연구 문서가 없습니다</h3>
                  <p className="center-empty-desc">
                    왼쪽 탐색기에서 정본 문서를 선택하거나, 새로운 연구 문서를 작성하여 가설과 수식을 체계적으로 정립하세요.
                  </p>
                  <button
                    type="button"
                    className="center-new-doc-btn"
                    onClick={() => { setTheoryDocumentId(null); setIsTheoryOpen(true); }}
                  >
                    <Plus size={16} />
                    <span>새 문서 시작</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </main>

        {/* Right Resizer */}
        <div
          className="pane-resizer pane-resizer-right"
          onMouseDown={handleRightResizerMouseDown}
          onDoubleClick={() => setChatWidth(380)}
          title="좌우로 드래그하여 채팅창 너비 조절 (더블클릭 시 380px 초기화)"
          role="separator"
          aria-orientation="vertical"
          aria-label="채팅창 너비 조절"
        />

        {/* Pane 3: Right Research Chat Sidebar */}
        <aside className="chat-sidebar-pane" style={{ width: `${chatWidth}px` }}>
          {currentSession && (
            <ChatPanelHeader
              currentSession={currentSession}
              onUpdateTitle={handleUpdateTitle}
              onNewSession={() => {
                handleNewSession();
                setIsHistoryOpen(false);
              }}
              currentMode={currentSession.researchMode}
              onModeChange={handleModeChange}
              isHistoryOpen={isHistoryOpen}
              onToggleHistory={() => setIsHistoryOpen(prev => !prev)}
            />
          )}

          {/* Global Key Alert Banner if no keys configured */}
          {!(settings.apiKeys.gemini.trim() || settings.apiKeys.openai.trim() || settings.apiKeys.anthropic.trim()) && (
            <div className="global-key-banner">
              <span>🔑 AI API 키가 아직 등록되지 않았습니다. 원활한 연구 대화를 위해 최소 1개의 키를 등록해 주세요.</span>
              <button className="banner-settings-btn" onClick={() => setIsSettingsOpen(true)}>
                키 설정하기 →
              </button>
            </div>
          )}

          {(initialStorageWarning || persistenceError) && (
            <div className="storage-warning" role="alert">
              <span>{initialStorageWarning || persistenceError}</span>
              {persistenceError && (
                <button
                  type="button"
                  onClick={() => {
                    void saveSessions(sessions)
                      .then(() => setPersistenceError(null))
                      .catch(error => setPersistenceError(getStorageErrorMessage(error)));
                  }}
                >
                  저장 다시 시도
                </button>
              )}
            </div>
          )}

          {isHistoryOpen ? (
            <div className="chat-history-drawer" role="region" aria-label="대화 기록 목록">
              <div className="chat-history-drawer-header">
                <div className="chat-history-drawer-title">
                  <History size={15} />
                  <span>대화 기록 ({visibleSessions.length})</span>
                </div>
                <div className="chat-history-drawer-actions">
                  <button
                    type="button"
                    className="chat-history-drawer-new-btn"
                    onClick={() => {
                      handleNewSession();
                      setIsHistoryOpen(false);
                    }}
                    title="새 대화 시작"
                    aria-label="새 대화"
                  >
                    <Plus size={14} />
                    <span>새 대화</span>
                  </button>
                  <button
                    type="button"
                    className="chat-history-drawer-close-btn"
                    onClick={() => setIsHistoryOpen(false)}
                    title="닫기"
                    aria-label="대화 기록 닫기"
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>

              <div className="chat-history-drawer-list">
                {visibleSessions.length === 0 ? (
                  <div className="chat-history-drawer-empty">저장된 연구 대화가 없습니다.</div>
                ) : (
                  visibleSessions.map(session => (
                    <div
                      key={session.id}
                      className={`chat-history-drawer-item ${currentSessionId === session.id ? 'active' : ''}`}
                    >
                      <button
                        type="button"
                        className="chat-history-drawer-item-select"
                        onClick={() => {
                          handleSelectSession(session.id);
                          setIsHistoryOpen(false);
                        }}
                        aria-label={`${session.title || '새로운 연구 대화'} 선택`}
                      >
                        <MessageSquare size={14} className="chat-history-drawer-item-icon" />
                        <div className="chat-history-drawer-item-text">
                          <span className="chat-history-drawer-item-title">
                            {session.title || '새로운 연구 대화'}
                          </span>
                          <span className="chat-history-drawer-item-meta">
                            {session.messages.length}개 메시지 · {new Date(session.updatedAt).toLocaleDateString()}
                          </span>
                        </div>
                      </button>
                      <button
                        type="button"
                        className="chat-history-drawer-item-delete"
                        onClick={event => {
                          event.stopPropagation();
                          requestDeleteSession(session.id, event.currentTarget);
                        }}
                        title="대화 삭제"
                        aria-label={`${session.title || '새로운 연구 대화'} 세션 삭제`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="chat-scroll-area">
                {!currentSession || currentSession.messages.length === 0 ? (
                  <EmptyState
                    onSelectPrompt={handleSendMessage}
                    currentMode={currentSession?.researchMode || 'general'}
                  />
                ) : (
                  <div className="messages-list">
                    <React.Suspense
                      fallback={<div className="message-renderer-loading" role="status">대화 렌더러 불러오는 중…</div>}
                    >
                      {currentSession.messages.map((message, index) => (
                        <ChatMessage
                          key={message.id}
                          message={message}
                          onOpenSource={setSourceEvidence}
                          onRetry={
                            index === currentSession.messages.length - 1
                            && message.role === 'assistant'
                            && (message.status === 'error' || message.status === 'stopped')
                              ? () => handleRetryMessage(message.id)
                              : undefined
                          }
                        />
                      ))}
                    </React.Suspense>
                    <div ref={messagesEndRef} />
                  </div>
                )}
              </div>

              {/* Input Dock */}
              <ChatInput
                onSendMessage={handleSendMessage}
                isStreaming={isStreaming}
                onStopStreaming={handleStopStreaming}
                currentMode={currentSession?.researchMode || 'general'}
                selectedModel={currentSession?.selectedModel}
                onModelChange={handleModelChange}
                apiKeys={settings.apiKeys}
              />
            </>
          )}
        </aside>
      </div>

      {pendingDeleteSessionId && (() => {
        const target = sessions.find(session => session.id === pendingDeleteSessionId);
        if (!target) return null;
        return (
          <div className="session-delete-backdrop">
            <div
              className="session-delete-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="session-delete-title"
              aria-describedby="session-delete-description"
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeDeleteSessionDialog();
                  return;
                }
                if (event.key !== 'Tab') return;
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
                if (!buttons.length) return;
                const first = buttons[0];
                const last = buttons[buttons.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first.focus();
                }
              }}
            >
              <h3 id="session-delete-title">대화를 삭제할까요?</h3>
              <p id="session-delete-description">
                연구 세션 “{target.title || '새로운 연구 대화'}”와 메시지 {target.messages.length}개를 삭제합니다. 이 작업은 되돌릴 수 없습니다.
              </p>
              <div className="session-delete-actions">
                <button ref={deleteDialogCancelRef} type="button" onClick={closeDeleteSessionDialog} disabled={isDeletingSession}>취소</button>
                <button type="button" className="session-delete-confirm" onClick={() => void handleDeleteSession()} disabled={isDeletingSession}>
                  {isDeletingSession ? '삭제 중…' : '대화 삭제'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {pendingDeleteDocumentId && (
        <div className="session-delete-backdrop">
          <div
            className="session-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="document-delete-title"
            aria-describedby="document-delete-description"
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeDeleteDocumentDialog();
                return;
              }
              if (event.key !== 'Tab') return;
              const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
              if (!buttons.length) return;
              const first = buttons[0];
              const last = buttons[buttons.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
          >
            <h3 id="document-delete-title">연구 문서를 삭제할까요?</h3>
            <p id="document-delete-description">
              “{documentDeletePreview?.title ?? theoryDocuments.find(row => row.id === pendingDeleteDocumentId)?.title ?? '선택한 문서'}”
              {documentDeletePreview && <>의 버전 {documentDeletePreview.versionCount}개, 문단 {documentDeletePreview.blockCount}개, 검토 기록 {documentDeletePreview.reviewCount}개를 삭제합니다.
                {' '}{documentDeletePreview.projectAction === 'remove' ? '이 문서만 있는 프로젝트도 삭제됩니다.'
                  : documentDeletePreview.projectAction === 'choose_representative' ? '다른 문서가 프로젝트 대표가 됩니다.' : '다른 문서는 유지됩니다.'}
              </>}
              {' '}이 작업은 현재 작업공간에서 되돌릴 수 없습니다.
            </p>
            {isPreparingDocumentDelete && <p role="status" className="document-delete-feedback">삭제 범위 확인 중…</p>}
            {documentDeleteError && <p role="alert" className="document-delete-feedback">{documentDeleteError}</p>}
            <div className="session-delete-actions">
              <button ref={documentDeleteCancelRef} type="button" onClick={closeDeleteDocumentDialog} disabled={isDeletingDocument}>취소</button>
              <button type="button" className="session-delete-confirm" onClick={() => void handleDeleteDocument()}
                disabled={!documentDeletePreview || isPreparingDocumentDelete || isDeletingDocument}>
                {isDeletingDocument ? '삭제 중…' : '문서 삭제'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings & Other Modals */}
      {isReferencesOpen && (
        <React.Suspense fallback={<div role="status">레퍼런스 불러오는 중…</div>}>
          <ReferenceLibrary
            onClose={() => setIsReferencesOpen(false)}
            embeddingApiKey={settings.apiKeys.openai}
            canAsk={!isStreaming && Boolean(findAvailableModel(settings.apiKeys))}
            canDelete={!isStreaming}
            modelName={(AVAILABLE_MODELS.find(model => model.id === currentSession?.selectedModel && settings.apiKeys[model.provider as keyof typeof settings.apiKeys]?.trim()) || findAvailableModel(settings.apiKeys))?.name || 'API 키 설정 필요'}
            onAsk={(query, bundle) => { setIsReferencesOpen(false); void handleSendMessage(query, { contextBundle: bundle }); }}
          />
        </React.Suspense>
      )}
      {sourceEvidence && (
        <React.Suspense fallback={<div role="status">원문 불러오는 중…</div>}>
          <ReferenceSource evidence={sourceEvidence} onClose={() => setSourceEvidence(null)} />
        </React.Suspense>
      )}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSaveSettings={handleSaveSettings}
        onExportWorkspace={handleExportWorkspace}
        onExportWorkspaceToFolder={handleExportWorkspaceToFolder}
        onExportTheoryToFolder={handleExportTheoryToFolder}
        onRestoreWorkspace={handleRestoreWorkspace}
      />
    </div>
  );
};

export default App;
