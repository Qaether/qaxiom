import React, { useEffect, useRef, useState } from 'react';
import { X, Key, Shield, ExternalLink, Save, CheckCircle2, Download, Upload } from 'lucide-react';
import type { UserSettings } from '../types';
import { AVAILABLE_MODELS } from '../constants';
import { workspaceDirectoryPicker } from '../services/folderExport';

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
    onSaveSettings(formState);
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
      setWorkspaceStatus('API 키를 제외한 작업공간 백업을 저장했습니다.');
    } catch (error) {
      setWorkspaceStatus(error instanceof Error ? error.message : '작업공간을 내보내지 못했습니다.');
    } finally {
      setIsWorkspaceBusy(false);
    }
  };

  const handleFolderExport = async () => {
    setIsWorkspaceBusy(true);
    setWorkspaceStatus(null);
    try {
      const filename = await onExportWorkspaceToFolder();
      setWorkspaceStatus(`선택한 폴더에 ${filename} 백업을 저장했습니다. API 키는 포함되지 않습니다.`);
    } catch (error) {
      setWorkspaceStatus(error instanceof Error ? error.message : '폴더에 작업공간을 저장하지 못했습니다.');
    } finally {
      setIsWorkspaceBusy(false);
    }
  };

  const handleTheoryFolderExport = async () => {
    setIsWorkspaceBusy(true);
    setWorkspaceStatus(null);
    try {
      const result = await onExportTheoryToFolder();
      setWorkspaceStatus(`선택한 폴더의 ${result.folderName}에 현재 연구노트 ${result.documentCount}개를 Markdown으로 저장했습니다. 전체 버전·근거는 별도 작업공간 JSON 백업에 보존됩니다.`);
    } catch (error) {
      setWorkspaceStatus(error instanceof Error ? error.message : '연구노트를 폴더에 저장하지 못했습니다.');
    } finally {
      setIsWorkspaceBusy(false);
    }
  };

  const handleWorkspaceRestore = async (file: File) => {
    if (!window.confirm('현재 작업공간을 이 백업으로 교체할까요? API 키와 설정은 유지됩니다.')) return;
    setIsWorkspaceBusy(true);
    setWorkspaceStatus(null);
    try {
      const sessionCount = await onRestoreWorkspace(file);
      setWorkspaceStatus(`작업공간을 복원했습니다. 세션 ${sessionCount}개를 불러왔습니다.`);
    } catch (error) {
      setWorkspaceStatus(error instanceof Error ? error.message : '작업공간을 복원하지 못했습니다.');
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
            <h3 id="settings-dialog-title">연구 AI 환경 설정 (BYOK)</h3>
          </div>
          <button ref={closeButtonRef} type="button" className="modal-close-btn" onClick={onClose} aria-label="설정 닫기">
            <X size={18} />
          </button>
        </div>

        {/* Modal Content */}
        <form onSubmit={handleSave} className="modal-body">
          {/* Welcome Onboarding Box (shown if no keys exist yet) */}
          {(!settings.apiKeys.gemini && !settings.apiKeys.openai && !settings.apiKeys.anthropic) && (
            <div className="onboarding-banner">
              <div className="onboarding-badge">👋 시작 가이드</div>
              <h4>Qaxiom에 오신 것을 환영합니다!</h4>
              <p>
                Qaxiom이 별도 백엔드를 운영하지 않는 <strong>BYOK 연구 AI</strong>입니다.
                연구 질문을 시작하려면 아래 AI 제공사 중 <strong>최소 1개의 API 키</strong>를 입력해 주세요.
              </p>
            </div>
          )}

          {/* Privacy Note */}
          <div className="security-notice">
            <Shield size={16} className="security-icon" />
            <div>
              <strong>로컬 키 저장 및 공급자 직접 연결</strong>
              <p>
                API 키는 이 브라우저 프로필의 로컬 스토리지에 저장됩니다. 질문과 첨부할 콘텐츠는
                선택한 AI 제공사로 직접 전송되며 해당 제공사의 데이터 정책이 적용됩니다.
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
                <span>발급 페이지</span>
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
            <span className="input-hint">Gemini 3.8 Flash 및 Gemini 3.1 Pro Preview 호출에 사용됩니다.</span>
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
                <span>발급받기</span>
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
            <span className="input-hint">GPT-6 Astra, GPT-6.1 Sol 및 GPT-6 Luna 호출에 사용됩니다.</span>
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
                <span>발급받기</span>
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
            <span className="input-hint">Claude Opus 5 및 Claude Sonnet 5 호출에 사용됩니다.</span>
          </div>

          {/* Default Model */}
          <div className="form-group">
            <label htmlFor="default-model-select">기본 추론 모델</label>
            <select
              id="default-model-select"
              className="select-input"
              value={formState.defaultModel}
              onChange={e => setFormState({ ...formState, defaultModel: e.target.value })}
            >
              {AVAILABLE_MODELS.map(model => (
                <option key={model.id} value={model.id}>
                  {model.name} ({model.provider.toUpperCase()}) {model.status === 'preview' ? '— Preview' : ''} {model.recommended ? '— 추천' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Temperature */}
          <div className="form-group">
            <div className="form-label-row">
              <label htmlFor="temp-range">
                추론 온도 (Temperature): {selectedDefaultModel?.supportsTemperature ? formState.temperature : '선택 모델 미지원'}
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
                <span>0.0 (엄밀함 / 학술 분석)</span>
                <span>1.0 (창의적 / 발산적 아이디어)</span>
              </div>
            ) : (
              <span className="input-hint">이 모델은 고정된 reasoning 설정을 사용하므로 temperature를 전송하지 않습니다.</span>
            )}
          </div>

          <div className="form-group workspace-transfer">
            <div className="form-label-row">
              <label>작업공간 백업과 복원</label>
            </div>
            <p className="input-hint">
              세션, 메시지, 문서와 위키 데이터를 버전형 JSON으로 저장합니다. API 키와 설정은 포함하지 않습니다.
              복원하면 현재 작업공간 데이터가 교체됩니다.
              폴더 저장은 지원 브라우저의 보안 컨텍스트에서만 가능하며, 매번 새 이름의 백업을 만듭니다. 연구노트 Markdown 저장은 현재 버전만 내보내므로 전체 복원에는 JSON 백업이 필요합니다.
            </p>
            <div className="workspace-transfer-actions">
              <button
                type="button"
                className="workspace-transfer-btn"
                disabled={isWorkspaceBusy}
                onClick={() => void handleWorkspaceExport()}
              >
                <Download size={15} />
                작업공간 백업
              </button>
              <button
                type="button"
                className="workspace-transfer-btn"
                disabled={isWorkspaceBusy || !workspaceDirectoryPicker()}
                onClick={() => void handleFolderExport()}
                title={workspaceDirectoryPicker() ? '선택한 폴더에 새 JSON 백업 저장' : '이 브라우저에서는 폴더 저장을 지원하지 않습니다. 작업공간 백업 다운로드를 사용하세요.'}
              >
                <Download size={15} />
                폴더에 저장
              </button>
              <button
                type="button"
                className="workspace-transfer-btn"
                disabled={isWorkspaceBusy || !workspaceDirectoryPicker()}
                onClick={() => void handleTheoryFolderExport()}
                title={workspaceDirectoryPicker() ? '현재 연구노트 버전을 Markdown 폴더로 내보내기' : '이 브라우저에서는 폴더 저장을 지원하지 않습니다.'}
              >
                <Download size={15} />
                연구노트 Markdown 저장
              </button>
              <button
                type="button"
                className="workspace-transfer-btn"
                disabled={isWorkspaceBusy}
                onClick={() => restoreInputRef.current?.click()}
              >
                <Upload size={15} />
                작업공간 복원
              </button>
              <input
                ref={restoreInputRef}
                type="file"
                accept="application/json,.json"
                className="workspace-file-input"
                aria-label="Qaxiom 작업공간 백업 파일"
                onChange={event => {
                  const file = event.target.files?.[0];
                  if (file) void handleWorkspaceRestore(file);
                }}
              />
            </div>
            {workspaceStatus && <div className="workspace-transfer-status" role="status">{workspaceStatus}</div>}
          </div>

          {/* Modal Footer */}
          <div className="modal-footer">
            <button type="button" className="btn-cancel" onClick={onClose}>
              취소
            </button>
            <button type="submit" id="save-settings-btn" className="btn-save">
              {savedSuccess ? (
                <>
                  <CheckCircle2 size={16} />
                  <span>저장 완료!</span>
                </>
              ) : (
                <>
                  <Save size={16} />
                  <span>설정 저장</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
