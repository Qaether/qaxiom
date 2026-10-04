import Dexie, { type Table } from 'dexie';
import { resolveModelId } from '../constants';
import type { ChatMessage, ChatSession, ResearchMode, WikiPage } from '../types';
import type { ResearchProject, TheoryDocument, DocumentVersion, DocumentBlock } from './theory/types';
import type { ReferenceDocument, ReferenceSpan } from './retrieval/types';
import type { PdfAsset } from './retrieval/pdfTypes';
import type { ReviewRun } from './theory/reviewTypes';
import type { AnalysisRun } from './theory/analysis';
import type { ReviewCampaign } from './theory/campaigns';
import type { EmbeddingSpace, EmbeddingVector, EmbeddingManifest, EmbeddingActivation } from './retrieval/embeddingTypes';
import type { ResearchRelation } from './theory/relationTypes';
import type { ExternalClaim } from './theory/externalClaims';
import type { ExternalClaimLink } from './theory/externalClaimLinks';
import type { WorkspaceDirectoryHandle } from './folderExport';

export const DATABASE_NAME = 'qaxiom_workspace_v1';
export const LEGACY_SESSIONS_KEY = 'qaxiom_chat_sessions_v1';
const SESSION_MIGRATION_KEY = 'legacy_sessions_v1';

export interface SessionRecord {
  id: string;
  documentId?: string | null;
  position: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  researchMode: ResearchMode;
  selectedModel: string;
}

export interface MessageRecord extends ChatMessage {
  sessionId: string;
  position: number;
}

export interface DocumentRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  status: 'pending' | 'ready' | 'failed' | 'ocr_required';
}

export interface DocumentChunkRecord {
  id: string;
  documentId: string;
  position: number;
  page?: number;
  text: string;
}

export interface SourceSpanRecord {
  id: string;
  documentId: string;
  messageId?: string;
  wikiPageId?: string;
  page?: number;
  startOffset: number;
  endOffset: number;
  quote: string;
}

export interface JobRecord {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  errorMessage?: string;
}

interface MetadataRecord {
  key: string;
  completedAt: number;
  sourceCount: number;
}

export interface ProjectFolderRecord {
  id: string;
  name: string;
  folderName: string;
  directory: WorkspaceDirectoryHandle;
  updatedAt?: number;
}

export class QaxiomDatabase extends Dexie {
  sessions!: Table<SessionRecord, string>;
  messages!: Table<MessageRecord, [string, string]>;
  documents!: Table<DocumentRecord, string>;
  document_chunks!: Table<DocumentChunkRecord, string>;
  wiki_pages!: Table<WikiPage, string>;
  source_spans!: Table<SourceSpanRecord, string>;
  jobs!: Table<JobRecord, string>;
  metadata!: Table<MetadataRecord, string>;
  projects!: Table<ResearchProject, string>;
  theory_documents!: Table<TheoryDocument, string>;
  document_versions!: Table<DocumentVersion, string>;
  document_blocks!: Table<DocumentBlock, [string, string]>;
  references!: Table<ReferenceDocument, string>;
  reference_spans!: Table<ReferenceSpan, string>;
  pdf_assets!: Table<PdfAsset, string>;
  review_runs!: Table<ReviewRun, string>;
  analysis_runs!: Table<AnalysisRun, string>;
  review_campaigns!: Table<ReviewCampaign, string>;
  embedding_spaces!: Table<EmbeddingSpace, string>;
  embedding_vectors!: Table<EmbeddingVector, [string, string]>;
  embedding_manifests!: Table<EmbeddingManifest, string>;
  embedding_activations!: Table<EmbeddingActivation, string>;
  research_relations!: Table<ResearchRelation, string>;
  external_claims!: Table<ExternalClaim, string>;
  external_claim_links!: Table<ExternalClaimLink, string>;
  project_folders!: Table<ProjectFolderRecord, string>;

  constructor(name = DATABASE_NAME) {
    super(name);
    this.version(1).stores({
      sessions: '&id, position, updatedAt, createdAt',
      messages: '[sessionId+id], sessionId, [sessionId+position], timestamp',
      documents: '&id, updatedAt, createdAt, status',
      document_chunks: '&id, documentId, [documentId+position]',
      wiki_pages: '&id, updatedAt, *tags',
      source_spans: '&id, documentId, messageId, wikiPageId',
      jobs: '&id, status, updatedAt',
      metadata: '&key'
    });
    this.version(2).stores({
      projects: '&id, createdAt',
      theory_documents: '&id, projectId, updatedAt',
      document_versions: '&id, documentId, &[documentId+number], contentHash',
      document_blocks: '[versionId+id], versionId, documentId, [versionId+position]'
    });
    this.version(3).stores({
      references: '&id, &contentHash, createdAt, originVersionId',
      reference_spans: '&id, sourceId, &[sourceId+position]'
    });
    this.version(4).stores({
      references: '&id, contentHash, createdAt, originVersionId',
      pdf_assets: '&id, &fileHash, status, createdAt'
    });
    this.version(5).stores({ review_runs: '&id, documentId, versionId, createdAt' });
    this.version(6).stores({ review_campaigns: '&id, documentId, &activeDocumentId, createdAt' });
    this.version(7).stores({ embedding_spaces: '&id, createdAt', embedding_vectors: '[spaceId+spanId], spaceId, sourceId' });
    this.version(8).stores({ embedding_manifests: '&spaceId, createdAt', embedding_activations: '&id' });
    this.version(9).stores({ research_relations: '&id, documentId, createdAt' });
    this.version(10).stores({ review_runs: '&id, documentId, versionId, createdAt', review_campaigns: '&id, &activeDocumentId, documentId, createdAt' });
    this.version(11).stores({ messages: '[sessionId+id], sessionId, [sessionId+position], timestamp' });
    this.version(12).stores({ messages: '[sessionId+id], sessionId, [sessionId+position], timestamp' });
    this.version(13).stores({ review_campaigns: '&id, &activeDocumentId, documentId, createdAt' });
    this.version(14).stores({ review_runs: '&id, documentId, versionId, createdAt' });
    this.version(15).stores({ review_runs: '&id, documentId, versionId, createdAt', review_campaigns: '&id, &activeDocumentId, documentId, createdAt' });
    this.version(16).stores({ research_relations: '&id, documentId, createdAt' });
    this.version(17).stores({ projects: '&id, createdAt' });
    this.version(18).stores({ projects: '&id, createdAt' });
    this.version(19).stores({ projects: '&id, createdAt' });
    this.version(20).stores({ external_claims: '&id, projectId, [runId+pairId], sourceId, acceptedAt' });
    this.version(21).stores({ external_claim_links: '&id, fromProjectId, toProjectId, fromClaimId, toClaimId, createdAt' });
    this.version(22).stores({ document_versions: '&id, documentId, &[documentId+number], contentHash' }).upgrade(async transaction => {
      await transaction.table('document_versions').toCollection().modify(version => {
        if (version.contractAnchors === undefined) version.contractAnchors = {};
      });
    });
    this.version(23).stores({ project_folders: '&id' });
    this.version(24).stores({ sessions: '&id, documentId, position, updatedAt, createdAt' }).upgrade(async transaction => {
      await transaction.table('sessions').toCollection().modify(session => {
        if (session.documentId === undefined) session.documentId = null;
      });
    });
    this.version(25).stores({ analysis_runs: '&id, documentId, versionId, createdAt' });
  }
}

export const qaxiomDatabase = new QaxiomDatabase();

function toSessionRecord(session: ChatSession, position: number): SessionRecord {
  return {
    id: session.id,
    documentId: session.documentId ?? null,
    position,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    researchMode: session.researchMode,
    selectedModel: resolveModelId(session.selectedModel)
  };
}

function toMessageRecords(session: ChatSession): MessageRecord[] {
  return session.messages.map((message, position) => ({
    ...message,
    sessionId: session.id,
    position
  }));
}

function parseLegacySessions(raw: string): ChatSession[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('기존 대화 데이터가 배열 형식이 아닙니다.');
  }

  const sessionIds = new Set<string>();
  return parsed.map((value, sessionIndex) => {
    if (!value || typeof value !== 'object') {
      throw new Error(`기존 세션 ${sessionIndex + 1}의 형식이 올바르지 않습니다.`);
    }

    const session = value as ChatSession;
    if (typeof session.id !== 'string' || !session.id || sessionIds.has(session.id)) {
      throw new Error(`기존 세션 ${sessionIndex + 1}의 ID가 없거나 중복되었습니다.`);
    }
    if (!Array.isArray(session.messages)) {
      throw new Error(`기존 세션 ${session.id}의 메시지 목록이 올바르지 않습니다.`);
    }

    const messageIds = new Set<string>();
    for (const message of session.messages) {
      if (!message || typeof message.id !== 'string' || !message.id || messageIds.has(message.id)) {
        throw new Error(`기존 세션 ${session.id}에 ID가 없거나 중복된 메시지가 있습니다.`);
      }
      messageIds.add(message.id);
    }

    sessionIds.add(session.id);
    return {
      ...session,
      selectedModel: resolveModelId(session.selectedModel)
    };
  });
}

export interface MigrationResult {
  migrated: boolean;
  sourceCount: number;
}

export async function migrateLegacySessions(
  database: QaxiomDatabase = qaxiomDatabase,
  storage: Storage = localStorage
): Promise<MigrationResult> {
  const completed = await database.metadata.get(SESSION_MIGRATION_KEY);
  if (completed) {
    storage.removeItem(LEGACY_SESSIONS_KEY);
    return { migrated: false, sourceCount: completed.sourceCount };
  }

  const raw = storage.getItem(LEGACY_SESSIONS_KEY);
  const legacySessions = raw ? parseLegacySessions(raw) : [];

  await database.transaction(
    'rw',
    database.sessions,
    database.messages,
    database.metadata,
    async () => {
      const existingIds = new Set(await database.sessions.toCollection().primaryKeys());
      const sessionsToImport = legacySessions.filter(session => !existingIds.has(session.id));
      const sessionRecords = sessionsToImport.map((session, position) => toSessionRecord(session, position));
      const messageRecords = sessionsToImport.flatMap(toMessageRecords);

      if (sessionRecords.length > 0) await database.sessions.bulkAdd(sessionRecords);
      if (messageRecords.length > 0) await database.messages.bulkAdd(messageRecords);
      await database.metadata.add({
        key: SESSION_MIGRATION_KEY,
        completedAt: Date.now(),
        sourceCount: legacySessions.length
      });
    }
  );

  storage.removeItem(LEGACY_SESSIONS_KEY);
  return { migrated: legacySessions.length > 0, sourceCount: legacySessions.length };
}

export async function loadSessionsFromDatabase(
  database: QaxiomDatabase = qaxiomDatabase
): Promise<ChatSession[]> {
  const [sessionRecords, messageRecords] = await Promise.all([
    database.sessions.orderBy('position').toArray(),
    database.messages.toArray()
  ]);
  const messagesBySession = new Map<string, MessageRecord[]>();

  for (const message of messageRecords) {
    const existing = messagesBySession.get(message.sessionId) || [];
    existing.push(message);
    messagesBySession.set(message.sessionId, existing);
  }

  return sessionRecords.map(session => ({
    id: session.id,
    documentId: session.documentId ?? null,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    researchMode: session.researchMode,
    selectedModel: resolveModelId(session.selectedModel),
    messages: (messagesBySession.get(session.id) || [])
      .sort((left, right) => left.position - right.position)
      .map(({ sessionId: _sessionId, position: _position, ...message }) => message)
  }));
}

const sessionCache = new Map<string, string>();
const messageCache = new Map<string, string>();
let cacheDatabaseName: string | null = null;
let persistenceQueue: Promise<void> = Promise.resolve();

function messageCacheKey(message: Pick<MessageRecord, 'sessionId' | 'id'>): string {
  return `${message.sessionId}\u0000${message.id}`;
}

async function hydratePersistenceCache(database: QaxiomDatabase): Promise<void> {
  if (cacheDatabaseName === database.name) return;
  const [sessions, messages] = await Promise.all([
    database.sessions.toArray(),
    database.messages.toArray()
  ]);
  sessionCache.clear();
  messageCache.clear();
  for (const session of sessions) sessionCache.set(session.id, JSON.stringify(session));
  for (const message of messages) messageCache.set(messageCacheKey(message), JSON.stringify(message));
  cacheDatabaseName = database.name;
}

async function persistSessionSnapshot(
  sessions: ChatSession[],
  database: QaxiomDatabase
): Promise<void> {
  await hydratePersistenceCache(database);

  const desiredSessions = sessions.map((session, position) => toSessionRecord(session, position));
  const desiredMessages = sessions.flatMap(toMessageRecords);
  const desiredSessionJson = new Map(desiredSessions.map(record => [record.id, JSON.stringify(record)]));
  const desiredMessageJson = new Map(
    desiredMessages.map(record => [messageCacheKey(record), JSON.stringify(record)])
  );
  const changedSessions = desiredSessions.filter(
    record => sessionCache.get(record.id) !== desiredSessionJson.get(record.id)
  );
  const changedMessages = desiredMessages.filter(
    record => messageCache.get(messageCacheKey(record)) !== desiredMessageJson.get(messageCacheKey(record))
  );
  const removedSessionIds = [...sessionCache.keys()].filter(id => !desiredSessionJson.has(id));
  const removedMessageKeys = [...messageCache.keys()]
    .filter(key => !desiredMessageJson.has(key))
    .map(key => key.split('\u0000') as [string, string]);
  const survivingMessageIds = new Set(desiredMessages.map(record => record.id));
  const removedMessageIds = [...new Set(removedMessageKeys.map(([, id]) => id))]
    .filter(id => !survivingMessageIds.has(id));

  await database.transaction('rw', database.sessions, database.messages, database.source_spans, async () => {
    const linkedSpans = removedMessageIds.length
      ? await database.source_spans.where('messageId').anyOf(removedMessageIds).toArray()
      : [];
    if (changedSessions.length > 0) await database.sessions.bulkPut(changedSessions);
    if (changedMessages.length > 0) await database.messages.bulkPut(changedMessages);
    if (removedMessageKeys.length > 0) await database.messages.bulkDelete(removedMessageKeys);
    if (removedSessionIds.length > 0) await database.sessions.bulkDelete(removedSessionIds);
    const exclusiveSpanIds = linkedSpans.filter(span => !span.wikiPageId).map(span => span.id);
    const sharedSpanIds = linkedSpans.filter(span => span.wikiPageId).map(span => span.id);
    if (exclusiveSpanIds.length) await database.source_spans.bulkDelete(exclusiveSpanIds);
    if (sharedSpanIds.length) await database.source_spans.where('id').anyOf(sharedSpanIds).modify(span => { delete span.messageId; });
  });

  sessionCache.clear();
  messageCache.clear();
  for (const [id, json] of desiredSessionJson) sessionCache.set(id, json);
  for (const [key, json] of desiredMessageJson) messageCache.set(key, json);
}

export function saveSessionsToDatabase(
  sessions: ChatSession[],
  database: QaxiomDatabase = qaxiomDatabase
): Promise<void> {
  const snapshot = sessions.map(session => ({
    ...session,
    messages: session.messages.map(message => ({ ...message }))
  }));
  const operation = persistenceQueue.then(() => persistSessionSnapshot(snapshot, database));
  persistenceQueue = operation.catch(() => undefined);
  return operation;
}

export function resetPersistenceState(): void {
  sessionCache.clear();
  messageCache.clear();
  cacheDatabaseName = null;
  persistenceQueue = Promise.resolve();
}

export async function flushSessionWrites(): Promise<void> {
  await persistenceQueue;
}

export interface SessionStorageInitialization {
  sessions: ChatSession[];
  warning?: string;
}

export async function initializeSessionStorage(
  database: QaxiomDatabase = qaxiomDatabase,
  storage: Storage = localStorage
): Promise<SessionStorageInitialization> {
  try {
    await migrateLegacySessions(database, storage);
    return { sessions: await loadSessionsFromDatabase(database) };
  } catch (error) {
    const message = error instanceof Error ? error.message : '알 수 없는 저장소 오류';
    let sessions: ChatSession[] = [];
    try {
      sessions = await loadSessionsFromDatabase(database);
    } catch {
      // Keep the app usable with an in-memory session when IndexedDB is unavailable.
    }
    return {
      sessions,
      warning: `대화 저장소를 초기화하지 못했습니다. 기존 데이터는 보존했습니다. (${message})`
    };
  }
}
