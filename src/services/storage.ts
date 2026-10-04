import type { ChatSession, ResearchMode, UserSettings } from '../types';
import { DEFAULT_SETTINGS, resolveModelId } from '../constants';
import { saveSessionsToDatabase } from './database';

const SETTINGS_KEY = 'qaxiom_user_settings_v1';

export function loadSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    const merged = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      defaultModel: resolveModelId(parsed.defaultModel || DEFAULT_SETTINGS.defaultModel),
      apiKeys: {
        ...DEFAULT_SETTINGS.apiKeys,
        ...(parsed.apiKeys || {})
      }
    };
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: UserSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('설정 저장 실패:', e);
  }
}

export function saveSessions(sessions: ChatSession[]): Promise<void> {
  return saveSessionsToDatabase(sessions);
}

export function createNewSession(
  mode: ResearchMode = 'general',
  model: string = DEFAULT_SETTINGS.defaultModel,
  documentId: string | null = null
): ChatSession {
  const newSession: ChatSession = {
    id: 'session_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    documentId,
    title: '새로운 연구 대화',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    researchMode: mode,
    selectedModel: model
  };
  return newSession;
}
