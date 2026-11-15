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
import { AVAILABLE_MODELS, resolveModelId } from './constants';
import {
  createAssistantMessage,
  createUserMessage,
  getRetryContext
} from './services/chatState';
import { flushSessionWrites, loadSessionsFromDatabase } from './services/database';
import { listTheories, loadTheory } from './services/theory/documents';
import { deleteTheory, prepareTheoryDeletion, type TheoryDeletionPreview } from './services/theory/theoryDeletion';
import { deleteProjectFolder, folderPermission, getActiveProjectFolder, listRecentProjectFolders, rememberProjectFolder, renameProjectFolder, requestFolderPermission } from './services/projectFolder';
import type { ContextBundle, ContextEvidence } from './services/retrieval/types';
import { withReferenceContext } from './services/retrieval/context';
import { captureDocumentContext, sessionsForDocument, verifyDocumentContext, withDocumentContext, type DocumentDraft } from './services/documentChat';
import { internalLightModel, LIGHT_CHAT_MODELS, obviousLightGreeting } from './services/chatRouting';
import {
  createWorkspaceBundle,
  restoreWorkspaceBundle,
  serializeWorkspaceBundle
} from './services/workspace';

import type { IncomingDraftAction } from './components/TheoryWorkspace';
import { useHarnessSession } from './hooks/useHarnessSession';

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
    return 'Could not save chat because browser storage is full. Please clear unnecessary data or export your chats.';
  }
  return 'Could not write chat to browser storage. Please check private browsing mode or browser storage settings.';
}

export const App: React.FC<AppProps> = ({ initialSessions, initialStorageWarning }) => {
  const [initialState] = useState(() => createInitialAppState(initialSessions));
  const [sessions, setSessions] = useState<ChatSession[]>(initialState.sessions);
  const [currentSessionId, setCurrentSessionId] = useState(initialState.currentSessionId);
  const [settings, setSettings] = useState<UserSettings>(initialState.settings);
  const [isSettingsOpen, setIsSettingsOpen] = useState(initialState.isSettingsOpen);
  const { isStreaming, stopStreaming, executeChatTurn } = useHarnessSession(setSessions);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [isTheoryOpen, setIsTheoryOpen] = useState(false);
  const [openedProject, setOpenedProject] = useState<OpenedProject | null>(null);
  const [rememberedProject, setRememberedProject] = useState<OpenedProject | null>(null);
  const [recentProjects, setRecentProjects] = useState<OpenedProject[]>([]);
  const [projectLoading, setProjectLoading] = useState(true);
  const [projectLoadError, setProjectLoadError] = useState('');
  const [theoryDocumentId, setTheoryDocumentId] = useState<string | null>(null);
  const [documentDraft, setDocumentDraft] = useState<DocumentDraft | null>(null);
  const [incomingDraft, setIncomingDraft] = useState<IncomingDraftAction | null>(null);
  const [activeChangeStatus, setActiveChangeStatus] = useState<'pending' | 'accepted' | 'rejected'>('pending');
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
    } catch { }
    return 260;
  });

  const [chatWidth, setChatWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('qaxiom_chat_width');
      if (saved) {
        const val = parseInt(saved, 10);
        if (!isNaN(val) && val >= 280 && val <= 650) return val;
      }
    } catch { }
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
      if (active) setDocumentDeleteError(cause instanceof Error ? cause.message : 'Failed to check document deletion scope.');
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
      } catch { }
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
      } catch { }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const closeMobileSidebar = () => {
    if (!isMobileSidebarOpen) return;
    setIsMobileSidebarOpen(false);
    requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
  };

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
      if (active) setProjectLoadError(cause instanceof Error ? cause.message : 'Failed to load project folder.');
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
          console.error('Failed to save session:', error);
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
          } catch { }
          const target = (lastId && docs.find(d => d.id === lastId)) || docs[0];
          return target.id;
        });
        setIsTheoryOpen(true);
      }
    }).catch(() => {
      if (active) setPersistenceError('Failed to load research notes list.');
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
    if (isStreaming) { window.alert('Please wait until response generation finishes before deleting a session.'); return; }
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
      setPersistenceError(`Failed to save session deletion. ${getStorageErrorMessage(error)}`);
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
      ? 'The current document has unsaved changes. Save or discard changes before deleting.'
      : isStreaming ? 'Please wait until response generation finishes before deleting a document.' : '';
    setDocumentDeletePreview(null);
    setDocumentDeleteError(reason);
    setIsPreparingDocumentDelete(!reason);
    setPendingDeleteDocumentId(id);
  };

  const handleDeleteDocument = async () => {
    if (!documentDeletePreview || isDeletingDocument || isPreparingDocumentDelete) return;
    if (isStreaming || documentDraft?.dirty && documentDraft.documentId === documentDeletePreview.documentId) {
      setDocumentDeleteError('Please wait until response generation or unsaved document edits finish, then try again.');
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
      } catch { }
      setPendingDeleteDocumentId(null);
      setPersistenceError(null);
      requestAnimationFrame(() => {
        const next = document.querySelector<HTMLButtonElement>('.sidebar-document');
        (next ?? document.getElementById('new-theory-btn'))?.focus();
      });
    } catch (cause) {
      setDocumentDeleteError(cause instanceof Error ? cause.message : 'Failed to delete document.');
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

  const handleApplyToDocument = (content: string) => {
    if (!isTheoryOpen && !theoryDocumentId) {
      setIsTheoryOpen(true);
    }
    setIncomingDraft({ text: content, mode: 'diff_review', token: Date.now() });
    setActiveChangeStatus('pending');
  };

  const handleDirectAcceptToDocument = (content: string) => {
    if (!isTheoryOpen && !theoryDocumentId) {
      setIsTheoryOpen(true);
    }
    setIncomingDraft({ text: content, mode: 'direct_accept', token: Date.now() });
    setActiveChangeStatus('accepted');
  };

  const handleAppendToDocument = (content: string) => {
    if (!isTheoryOpen && !theoryDocumentId) {
      setIsTheoryOpen(true);
    }
    setIncomingDraft({ text: content, mode: 'append', token: Date.now() });
  };

  const handleRejectDocumentChange = () => {
    setIncomingDraft(null);
    setActiveChangeStatus('rejected');
  };

  const handleSuggestionSettled = (status: 'accepted' | 'rejected') => {
    setActiveChangeStatus(status);
  };

  // Stop streaming
  const handleStopStreaming = stopStreaming;

  // Send message
  const handleSendMessage = async (
    userPrompt: string,
    options?: { retryAssistantMessageId?: string; contextBundle?: ContextBundle }
  ) => {
    if (!currentSession || isStreaming || deletingSessionRef.current) return;
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
    const route: 'light' | 'research' = contextBundle || currentSession.researchMode !== 'general'
      ? 'research'
      : priorAnswer
        ? (internalLightModel(priorAnswer.model ?? '') ? 'light' : 'research')
        : (obviousLightGreeting(userPrompt) ? 'light' : 'research');
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
        if (documentDraft?.documentId !== theoryDocumentId) throw new Error('Loading reference research note. Please ask again in a moment.');
        const prior = priorAnswer?.documentContext;
        if (prior && prior.documentId !== theoryDocumentId) throw new Error('The reference research note for the retried response differs from the current note.');
        documentContext = prior ?? await captureDocumentContext(theoryDocumentId, documentDraft);
        await verifyDocumentContext(documentContext);
        if (contextBundle?.assembly?.research && contextBundle.assembly.research.documentId !== theoryDocumentId)
          throw new Error('The research note of the selected retrieval context differs from the current note.');
        withDocumentContext(contextBundle ? withReferenceContext(updatedMessages, contextBundle) : updatedMessages, documentContext);
      }
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : 'Failed to verify research note context.');
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

    await executeChatTurn({
      sessionId: currentSession.id,
      assistantMessageId,
      modelId: responseModel.id,
      researchMode: currentSession.researchMode,
      settings,
      messages: route === 'light' ? [updatedMessages.at(-1)!] : updatedMessages,
      contextBundle: route === 'research' ? contextBundle : undefined,
      documentContext: route === 'research' ? documentContext : undefined,
      onProposedChange: proposedContent => {
        setActiveChangeStatus('pending');
        handleApplyToDocument(proposedContent);
      }
    });
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
    if (deletingSessionRef.current) throw new Error('Please wait until session deletion is saved before backing up.');
    if (isStreaming) throw new Error('Please wait until response generation finishes before backing up the workspace.');
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
    if (deletingSessionRef.current) throw new Error('Please wait until session deletion is saved before backing up.');
    if (isStreaming) throw new Error('Please wait until response generation finishes before backing up the workspace.');
    // The picker must be opened directly from the click before asynchronous database work.
    const directory = await chooseWorkspaceDirectory();
    await saveSessions(sessions);
    const bundle = await createWorkspaceBundle();
    return writeWorkspaceBackupToDirectory(directory, serializeWorkspaceBundle(bundle));
  };

  const handleExportTheoryToFolder = async (): Promise<{ folderName: string; documentCount: number }> => {
    if (deletingSessionRef.current) throw new Error('Please wait until session deletion is saved before exporting.');
    if (isStreaming) throw new Error('Please wait until response generation finishes before exporting research notes.');
    const directory = await chooseWorkspaceDirectory();
    await saveSessions(sessions);
    const bundle = await createWorkspaceBundle();
    return writeTheoryDocumentsToDirectory(directory, bundle);
  };

  const handleRestoreWorkspace = async (file: File): Promise<number> => {
    if (deletingSessionRef.current) throw new Error('Please wait until session deletion is saved before restoring.');
    if (isStreaming) throw new Error('Please wait until response generation finishes before restoring the workspace.');
    if (file.size > 100 * 1024 * 1024) {
      throw new Error('Backup file must be 100 MB or smaller.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      throw new Error('Invalid JSON backup file.');
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

  if (projectLoading) return <main className="project-start" role="status">Checking project connection…</main>;

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
        throw new Error('Folder access permission is required to open this project. Please grant permission again or choose another folder.');
      }
      await rememberProjectFolder(project);
      await refreshRecentProjects();
      setOpenedProject(project);
    }}
    onRenameProject={async (oldName, newName) => {
      await renameProjectFolder(oldName, newName);
      await refreshRecentProjects();
      if (rememberedProject && rememberedProject.name.trim().toLowerCase() === oldName.trim().toLowerCase()) {
        setRememberedProject({ ...rememberedProject, name: newName.trim() });
      }
    }}
    onDeleteProject={async project => {
      await deleteProjectFolder(project.name);
      await refreshRecentProjects();
      if (rememberedProject && rememberedProject.name.trim().toLowerCase() === project.name.trim().toLowerCase()) {
        setRememberedProject(null);
      }
    }}
    onReconnect={async () => {
      if (!rememberedProject || !await requestFolderPermission(rememberedProject.directory)) {
        throw new Error('Folder access permission is required to open this project. Please grant permission again or choose another folder.');
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
            } catch { }
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
          title="Drag left or right to resize explorer width (double-click to reset to 260px)"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize explorer sidebar"
        />

        {/* Pane 2: Center Research Document Editor */}
        <main className="center-document-pane">
          {/* Center Pane Content */}
          {isTheoryOpen || theoryDocumentId ? (
            <React.Suspense fallback={<div className="pane-loading" role="status">Loading research note…</div>}>
              <TheoryWorkspace
                key={newDocumentToken}
                onClose={() => { setIsTheoryOpen(false); setTheoryDocumentId(null); }}
                initialDocumentId={theoryDocumentId}
                settings={settings}
                modelId={currentSession?.selectedModel || settings.defaultModel}
                assistantDraft={currentSession?.messages.findLast(message => message.role === 'assistant' && message.status === 'complete')?.content}
                incomingDraft={incomingDraft}
                embedded={true}
                projectName={openedProject.name}
                onOpenMobileMenu={() => setIsMobileSidebarOpen(true)}
                onContextChange={setDocumentDraft}
                onSuggestionSettled={handleSuggestionSettled}
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
                    data-tooltip="Open chat menu"
                    aria-label="Open chat menu"
                    aria-expanded={isMobileSidebarOpen}
                    aria-controls="chat-sidebar"
                  >
                    <Menu size={18} />
                  </button>

                  <div className="header-project-chip header-project-label" aria-label={`Current project: ${openedProject.name}`}>
                    <Folder size={13} className="header-project-icon" />
                    <span className="header-project-name">{openedProject.name}</span>
                  </div>
                </div>

                <div className="center-header-right">
                  <button
                    type="button"
                    className="center-header-new-btn topbar-tooltip"
                    onClick={() => { setTheoryDocumentId(null); setIsTheoryOpen(true); }}
                    data-tooltip="New document"
                    aria-label="Create new document"
                  >
                    <Plus size={14} />
                    <span>New Document</span>
                  </button>
                </div>
              </div>

              <div className="center-empty-state">
                <div className="center-empty-card">
                  <div className="center-empty-icon">
                    <FileText size={40} />
                  </div>
                  <h3 className="center-empty-title">No research note open</h3>
                  <p className="center-empty-desc">
                    Select a canonical document from the left explorer, or create a new research note to systematically formalize hypotheses and equations.
                  </p>
                  <button
                    type="button"
                    className="center-new-doc-btn"
                    onClick={() => { setTheoryDocumentId(null); setIsTheoryOpen(true); }}
                  >
                    <Plus size={16} />
                    <span>Start New Document</span>
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
          title="Drag left or right to resize chat pane width (double-click to reset to 380px)"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat pane"
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
              <span>🔑 No AI API key configured yet. Add at least one key to start researching.</span>
              <button className="banner-settings-btn" onClick={() => setIsSettingsOpen(true)}>
                Configure Keys →
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
                  Retry Save
                </button>
              )}
            </div>
          )}

          {isHistoryOpen ? (
            <div className="chat-history-drawer" role="region" aria-label="Chat history list">
              <div className="chat-history-drawer-header">
                <div className="chat-history-drawer-title">
                  <History size={15} />
                  <span>Chat History ({visibleSessions.length})</span>
                </div>
                <div className="chat-history-drawer-actions">
                  <button
                    type="button"
                    className="chat-history-drawer-new-btn"
                    onClick={() => {
                      handleNewSession();
                      setIsHistoryOpen(false);
                    }}
                    title="Start new chat"
                    aria-label="New chat"
                  >
                    <Plus size={14} />
                    <span>New Chat</span>
                  </button>
                  <button
                    type="button"
                    className="chat-history-drawer-close-btn"
                    onClick={() => setIsHistoryOpen(false)}
                    title="Close"
                    aria-label="Close chat history"
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>

              <div className="chat-history-drawer-list">
                {visibleSessions.length === 0 ? (
                  <div className="chat-history-drawer-empty">No saved research chats.</div>
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
                        aria-label={`Select ${session.title || 'New research chat'}`}
                      >
                        <MessageSquare size={14} className="chat-history-drawer-item-icon" />
                        <div className="chat-history-drawer-item-text">
                          <span className="chat-history-drawer-item-title">
                            {session.title || 'New research chat'}
                          </span>
                          <span className="chat-history-drawer-item-meta">
                            {session.messages.length} messages · {new Date(session.updatedAt).toLocaleDateString('en-US')}
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
                        title="Delete chat"
                        aria-label={`Delete session ${session.title || 'New research chat'}`}
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
                      fallback={<div className="message-renderer-loading" role="status">Loading chat renderer…</div>}
                    >
                      {currentSession.messages.map((message, index) => (
                        <ChatMessage
                          key={message.id}
                          message={message}
                          originalDocumentContent={documentDraft?.markdown || ''}
                          onOpenSource={setSourceEvidence}
                          onApplyToDocument={handleApplyToDocument}
                          onDirectAcceptDocument={handleDirectAcceptToDocument}
                          onAppendToDocument={handleAppendToDocument}
                          onRejectDocumentChange={handleRejectDocumentChange}
                          changeStatus={index === currentSession.messages.length - 1 ? activeChangeStatus : undefined}
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
              <h3 id="session-delete-title">Delete chat?</h3>
              <p id="session-delete-description">
                This will delete the research session “{target.title || 'New research chat'}” and its {target.messages.length} message(s). This action cannot be undone.
              </p>
              <div className="session-delete-actions">
                <button ref={deleteDialogCancelRef} type="button" onClick={closeDeleteSessionDialog} disabled={isDeletingSession}>Cancel</button>
                <button type="button" className="session-delete-confirm" onClick={() => void handleDeleteSession()} disabled={isDeletingSession}>
                  {isDeletingSession ? 'Deleting…' : 'Delete Chat'}
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
            <h3 id="document-delete-title">Delete research note?</h3>
            <p id="document-delete-description">
              “{documentDeletePreview?.title ?? theoryDocuments.find(row => row.id === pendingDeleteDocumentId)?.title ?? 'Selected document'}”
              {documentDeletePreview && <>: {documentDeletePreview.versionCount} version(s), {documentDeletePreview.blockCount} block(s), and {documentDeletePreview.reviewCount} review record(s) will be deleted.
                {' '}{documentDeletePreview.projectAction === 'remove' ? 'The project containing only this document will also be deleted.'
                  : documentDeletePreview.projectAction === 'choose_representative' ? 'Another document will become the project representative.' : 'Other documents will be preserved.'}
              </>}
              {' '}This action cannot be undone in the current workspace.
            </p>
            {isPreparingDocumentDelete && <p role="status" className="document-delete-feedback">Checking deletion scope…</p>}
            {documentDeleteError && <p role="alert" className="document-delete-feedback">{documentDeleteError}</p>}
            <div className="session-delete-actions">
              <button ref={documentDeleteCancelRef} type="button" onClick={closeDeleteDocumentDialog} disabled={isDeletingDocument}>Cancel</button>
              <button type="button" className="session-delete-confirm" onClick={() => void handleDeleteDocument()}
                disabled={!documentDeletePreview || isPreparingDocumentDelete || isDeletingDocument}>
                {isDeletingDocument ? 'Deleting…' : 'Delete Document'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings & Other Modals */}
      {isReferencesOpen && (
        <React.Suspense fallback={<div role="status">Loading references…</div>}>
          <ReferenceLibrary
            onClose={() => setIsReferencesOpen(false)}
            embeddingApiKey={settings.apiKeys.openai}
            canAsk={!isStreaming && Boolean(findAvailableModel(settings.apiKeys))}
            canDelete={!isStreaming}
            modelName={(AVAILABLE_MODELS.find(model => model.id === currentSession?.selectedModel && settings.apiKeys[model.provider as keyof typeof settings.apiKeys]?.trim()) || findAvailableModel(settings.apiKeys))?.name || 'API key required'}
            onAsk={(query, bundle) => { setIsReferencesOpen(false); void handleSendMessage(query, { contextBundle: bundle }); }}
          />
        </React.Suspense>
      )}
      {sourceEvidence && (
        <React.Suspense fallback={<div role="status">Loading source…</div>}>
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
