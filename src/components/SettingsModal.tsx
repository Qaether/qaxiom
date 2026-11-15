import React, { useEffect, useRef, useState } from 'react';
import { X, Key, Shield, ExternalLink, Save, CheckCircle2, Download, Upload } from 'lucide-react';
import type { UserSettings } from '../types';
import { AVAILABLE_MODELS } from '../constants';
import { workspaceDirectoryPicker } from '../services/folderExport';
import { validateApiKeyFormat } from '../services/providers/apiKey';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: UserSettings;
  onSaveSettings: (settings: UserSettings) => void;
  onExportWorkspace: () => Promise<void>;
  onExportWorkspaceToFolder: () => Promise<string>;
  onExportTheoryToFolder: () => Promise<{ folderName: string; documentCount: number }>;
  onRestoreWorkspace: (file: File) => Promise<number>;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  onExportWorkspace,
  onExportWorkspaceToFolder,
  onExportTheoryToFolder,
  onRestoreWorkspace
}) => {
  const [formState, setFormState] = useState<UserSettings>(settings);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [workspaceStatus, setWorkspaceStatus] = useState<string | null>(null);
  const [isWorkspaceBusy, setIsWorkspaceBusy] = useState(false);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => previousFocus?.focus();
  }, [isOpen]);

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'))
      .filter(element => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!isOpen) return null;

  const selectedDefaultModel = AVAILABLE_MODELS.find(model => model.id === formState.defaultModel);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setKeyError(null);
    const trimmedKeys = {
      ...formState.apiKeys,
      gemini: formState.apiKeys.gemini.trim(),
      openai: formState.apiKeys.openai.trim(),
      anthropic: formState.apiKeys.anthropic.trim(),
      customUrl: formState.apiKeys.customUrl.trim(),
      customKey: formState.apiKeys.customKey.trim()
    };
    try {
      if (trimmedKeys.gemini) validateApiKeyFormat(trimmedKeys.gemini, 'Google Gemini');
      if (trimmedKeys.openai) validateApiKeyFormat(trimmedKeys.openai, 'OpenAI');
      if (trimmedKeys.anthropic) validateApiKeyFormat(trimmedKeys.anthropic, 'Anthropic');
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : 'Invalid API key format.');
      return;
    }
    const nextSettings: UserSettings = { ...formState, apiKeys: trimmedKeys };
    setFormState(nextSettings);
    onSaveSettings(nextSettings);
    setSavedSuccess(true);
    setTimeout(() => {
      setSavedSuccess(false);
      onClose();
    }, 800);
  };

  const handleWorkspaceExport = async () => {
    setIsWorkspaceBusy(true);
    setWorkspaceStatus(null);
    try {
      await onExportWorkspace();
      setWorkspaceStatus('Saved workspace backup (excluding API keys).');
    } catch (error) {
      setWorkspaceStatus(error instanceof Error ? error.message : 'Failed to export workspace.');
    } finally {
      setIsWorkspaceBusy(false);
    }
  };

  const handleFolderExport = async () => {
    setIsWorkspaceBusy(true);
    setWorkspaceStatus(null);
    try {
      const filename = await onExportWorkspaceToFolder();
      setWorkspaceStatus(`Saved backup ${filename} to the selected folder. API keys are not included.`);
    } catch (error) {
      setWorkspaceStatus(error instanceof Error ? error.message : 'Failed to save workspace to folder.');
    } finally {
      setIsWorkspaceBusy(false);
    }
  };

  const handleTheoryFolderExport = async () => {
    setIsWorkspaceBusy(true);
    setWorkspaceStatus(null);
    try {
      const result = await onExportTheoryToFolder();
      setWorkspaceStatus(`Saved ${result.documentCount} research note(s) as Markdown to ${result.folderName} in the selected folder. Full version history and sources are preserved in the workspace JSON backup.`);
    } catch (error) {
      setWorkspaceStatus(error instanceof Error ? error.message : 'Failed to save research notes to folder.');
    } finally {
      setIsWorkspaceBusy(false);
    }
  };

  const handleWorkspaceRestore = async (file: File) => {
    if (!window.confirm('Replace the current workspace with this backup? Your API keys and settings will be preserved.')) return;
    setIsWorkspaceBusy(true);
    setWorkspaceStatus(null);
    try {
      const sessionCount = await onRestoreWorkspace(file);
      setWorkspaceStatus(`Workspace restored. Loaded ${sessionCount} session(s).`);
    } catch (error) {
      setWorkspaceStatus(error instanceof Error ? error.message : 'Failed to restore workspace.');
    } finally {
      if (restoreInputRef.current) restoreInputRef.current.value = '';
      setIsWorkspaceBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={dialogRef} className="modal-card" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" onKeyDown={handleDialogKeyDown} onClick={e => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="modal-header">
          <div className="modal-header-title">
            <Key size={18} className="modal-icon" />
            <h3 id="settings-dialog-title">Research AI Settings (BYOK)</h3>
          </div>
          <button ref={closeButtonRef} type="button" className="modal-close-btn" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </div>

        {/* Modal Content */}
        <form onSubmit={handleSave} className="modal-body">
          {/* Welcome Onboarding Box (shown if no keys exist yet) */}
          {(!settings.apiKeys.gemini && !settings.apiKeys.openai && !settings.apiKeys.anthropic) && (
            <div className="onboarding-banner">
              <div className="onboarding-badge">👋 Getting Started</div>
              <h4>Welcome to Qaxiom!</h4>
              <p>
                Qaxiom is a <strong>BYOK Research AI</strong> with no separate backend.
                Enter <strong>at least one API key</strong> from the providers below to start asking research questions.
              </p>
            </div>
          )}

          {/* Privacy Note */}
          <div className="security-notice">
            <Shield size={16} className="security-icon" />
            <div>
              <strong>Local Key Storage & Direct Provider Connection</strong>
              <p>
                API keys are stored in this browser profile&apos;s local storage. Your prompts and selected content are
                sent directly to the chosen AI provider under that provider&apos;s data policy.
              </p>
            </div>
          </div>

          {/* API Keys */}
          <div className="form-group">
            <div className="form-label-row">
              <label htmlFor="gemini-key">Google Gemini API Key</label>
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
                className="external-link"
              >
                <span>Get API Key</span>
                <ExternalLink size={11} />
              </a>
            </div>
            <input
              id="gemini-key"
              type="password"
              className="text-input"
              placeholder="AIzaSy..."
              value={formState.apiKeys.gemini}
              onChange={e =>
                setFormState({
                  ...formState,
                  apiKeys: { ...formState.apiKeys, gemini: e.target.value }
                })
              }
            />
            <span className="input-hint">Used for Gemini 3.8 Flash and Gemini 3.1 Pro Preview.</span>
          </div>

          <div className="form-group">
            <div className="form-label-row">
              <label htmlFor="openai-key">OpenAI API Key</label>
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noreferrer"
                className="external-link"
              >
                <span>Get API Key</span>
                <ExternalLink size={11} />
              </a>
            </div>
            <input
              id="openai-key"
              type="password"
              className="text-input"
              placeholder="sk-proj-..."
              value={formState.apiKeys.openai}
              onChange={e =>
                setFormState({
                  ...formState,
                  apiKeys: { ...formState.apiKeys, openai: e.target.value }
                })
              }
            />
            <span className="input-hint">Used for GPT-6 Astra, GPT-6.1 Sol, and GPT-6 Luna.</span>
          </div>

          <div className="form-group">
            <div className="form-label-row">
              <label htmlFor="anthropic-key">Anthropic Claude API Key</label>
              <a
                href="https://console.anthropic.com/"
                target="_blank"
                rel="noreferrer"
                className="external-link"
              >
                <span>Get API Key</span>
                <ExternalLink size={11} />
              </a>
            </div>
            <input
              id="anthropic-key"
              type="password"
              className="text-input"
              placeholder="sk-ant-..."
              value={formState.apiKeys.anthropic}
              onChange={e =>
                setFormState({
                  ...formState,
                  apiKeys: { ...formState.apiKeys, anthropic: e.target.value }
                })
              }
            />
            <span className="input-hint">Used for Claude Opus 5 and Claude Sonnet 5.</span>
          </div>

          {/* Default Model */}
          <div className="form-group">
            <label htmlFor="default-model-select">Default Reasoning Model</label>
            <select
              id="default-model-select"
              className="select-input"
              value={formState.defaultModel}
              onChange={e => setFormState({ ...formState, defaultModel: e.target.value })}
            >
              {AVAILABLE_MODELS.map(model => (
                <option key={model.id} value={model.id}>
                  {model.name} ({model.provider.toUpperCase()}) {model.status === 'preview' ? '— Preview' : ''} {model.recommended ? '— Recommended' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Temperature */}
          <div className="form-group">
            <div className="form-label-row">
              <label htmlFor="temp-range">
                Temperature: {selectedDefaultModel?.supportsTemperature ? formState.temperature : 'Not supported by selected model'}
              </label>
            </div>
            <input
              id="temp-range"
              type="range"
              min="0.0"
              max="1.0"
              step="0.05"
              className="range-input"
              value={formState.temperature}
              disabled={!selectedDefaultModel?.supportsTemperature}
              onChange={e => setFormState({ ...formState, temperature: parseFloat(e.target.value) })}
            />
            {selectedDefaultModel?.supportsTemperature ? (
              <div className="range-labels">
                <span>0.0 (Rigorous / Academic)</span>
                <span>1.0 (Creative / Exploratory)</span>
              </div>
            ) : (
              <span className="input-hint">This model uses fixed reasoning settings and does not accept temperature.</span>
            )}
          </div>

          <div className="form-group workspace-transfer">
            <div className="form-label-row">
              <label>Workspace Backup & Restore</label>
            </div>
            <p className="input-hint">
              Exports sessions, messages, documents, and wiki data as versioned JSON (excluding API keys and settings).
              Restoring replaces your current workspace data.
              Folder export requires a supported browser in a secure context and creates a new timestamped backup each time. Markdown export only saves current note versions; use JSON backup for full restoration.
            </p>
            <div className="workspace-transfer-actions">
              <button
                type="button"
                className="workspace-transfer-btn"
                disabled={isWorkspaceBusy}
                onClick={() => void handleWorkspaceExport()}
              >
                <Download size={15} />
                Export Workspace
              </button>
              <button
                type="button"
                className="workspace-transfer-btn"
                disabled={isWorkspaceBusy || !workspaceDirectoryPicker()}
                onClick={() => void handleFolderExport()}
                title={workspaceDirectoryPicker() ? 'Save a new JSON backup to the selected folder' : 'Folder export is not supported in this browser. Use Export Workspace download instead.'}
              >
                <Download size={15} />
                Save to Folder
              </button>
              <button
                type="button"
                className="workspace-transfer-btn"
                disabled={isWorkspaceBusy || !workspaceDirectoryPicker()}
                onClick={() => void handleTheoryFolderExport()}
                title={workspaceDirectoryPicker() ? 'Export current research note versions to a Markdown folder' : 'Folder export is not supported in this browser.'}
              >
                <Download size={15} />
                Export Notes as Markdown
              </button>
              <button
                type="button"
                className="workspace-transfer-btn"
                disabled={isWorkspaceBusy}
                onClick={() => restoreInputRef.current?.click()}
              >
                <Upload size={15} />
                Restore Workspace
              </button>
              <input
                ref={restoreInputRef}
                type="file"
                accept="application/json,.json"
                className="workspace-file-input"
                aria-label="Qaxiom workspace backup file"
                onChange={event => {
                  const file = event.target.files?.[0];
                  if (file) void handleWorkspaceRestore(file);
                }}
              />
            </div>
            {workspaceStatus && <div className="workspace-transfer-status" role="status">{workspaceStatus}</div>}
          </div>

          {keyError && (
            <div className="workspace-transfer-status" role="alert" style={{ color: '#fda4af', margin: '0 20px 10px' }}>
              {keyError}
            </div>
          )}

          {/* Modal Footer */}
          <div className="modal-footer">
            <button type="button" className="btn-cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" id="save-settings-btn" className="btn-save">
              {savedSuccess ? (
                <>
                  <CheckCircle2 size={16} />
                  <span>Saved!</span>
                </>
              ) : (
                <>
                  <Save size={16} />
                  <span>Save Settings</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
