// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../constants';
import { loadSettings, saveSettings } from './storage';

describe('localStorage persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns defaults when settings JSON is missing or corrupted', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);

    localStorage.setItem('qaxiom_user_settings_v1', '{broken');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('merges partial settings and migrates legacy model IDs', () => {
    localStorage.setItem('qaxiom_user_settings_v1', JSON.stringify({
      defaultModel: 'claude-sonnet-5-5',
      apiKeys: { anthropic: 'test-key' }
    }));

    const settings = loadSettings();

    expect(settings.defaultModel).toBe('claude-sonnet-5');
    expect(settings.apiKeys.anthropic).toBe('test-key');
    expect(settings.apiKeys.openai).toBe('');
    expect(settings.defaultMode).toBe(DEFAULT_SETTINGS.defaultMode);
  });

  it('round-trips settings', () => {
    saveSettings({
      ...DEFAULT_SETTINGS,
      defaultModel: 'gemini-3.8-flash',
      apiKeys: { ...DEFAULT_SETTINGS.apiKeys, gemini: 'gemini-key' }
    });
    expect(loadSettings().defaultModel).toBe('gemini-3.8-flash');
  });
});
