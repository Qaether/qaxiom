import { useRef, useState } from 'react';
import { Sparkles, Check, Loader2, AlertCircle, FileText, CheckSquare, XCircle, ArrowRight } from 'lucide-react';
import { sendChatMessage } from '../services/llm';
import { combineContractSuggestions, CONTRACT_KEYS, parseContractSuggestions, prepareContractSuggestionRequests, type ContractKey, type ContractSuggestions } from '../services/theory/contractSuggestions';
import type { ResearchContract } from '../services/theory/types';
import type { UserSettings } from '../types';

const labels: Record<ContractKey, string> = {
  purpose: '연구 목적', assumptions: '가정·공리', definitions: '핵심 정의',
  symbols: '기호표', scope: '적용 범위', openQuestions: '미해결 문제'
};

type Source = { title: string; markdown: string; modelId: string };

export default function ContractSuggestionAssistant({ title, markdown, contract, modelId, settings, disabled, onBusyChange, onOpenCriteria, onApply }: {
  title: string; markdown: string; contract: ResearchContract; modelId: string; settings: UserSettings;
  disabled: boolean; onBusyChange: (busy: boolean) => void; onOpenCriteria: () => void;
  onApply: (value: ContractSuggestions, keys: ContractKey[]) => void;
}) {
  const [preview, setPreview] = useState<{ source: Source; requests: { prompt: string; markdown: string }[] } | null>(null);
  const [suggestions, setSuggestions] = useState<{ source: Source; values: ContractSuggestions } | null>(null);
  const [selected, setSelected] = useState<ContractKey[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const previewCurrent = preview && preview.source.title === title && preview.source.markdown === markdown && preview.source.modelId === modelId;
  const suggestionsCurrent = suggestions && suggestions.source.title === title && suggestions.source.markdown === markdown;
  const available = suggestionsCurrent ? CONTRACT_KEYS.filter(key => suggestions.values[key]) : [];

  const start = async () => {
    if (!preview || !previewCurrent || disabled || running) return;
    const abort = new AbortController(); controller.current = abort;
    setRunning(true); onBusyChange(true); setError(''); setSuggestions(null); setSelected([]);
    try {
      const parts: ContractSuggestions[] = [];
      for (const [index, request] of preview.requests.entries()) {
        if (abort.signal.aborted) throw new Error('AI 연구 기준 찾기가 중단되었습니다.');
        setProgress(index + 1);
        let response = '', failure: Error | null = null;
        const timer = window.setTimeout(() => abort.abort(), 120000);
        try {
          await sendChatMessage([{ id: crypto.randomUUID(), role: 'user', content: request.prompt, timestamp: Date.now() }],
            preview.source.modelId, 'general', settings, {
              onChunk: chunk => {
                response += chunk;
                if (response.length > 20000) { failure = new Error('AI 응답이 너무 깁니다. 다시 시도해 주세요.'); abort.abort(); }
              },
              onError: cause => { failure = cause; }, onFinish: () => {}
            }, abort.signal);
          if (failure) throw failure;
          if (abort.signal.aborted) throw new Error('AI 연구 기준 찾기가 중단되었거나 시간 제한을 넘었습니다.');
          parts.push(parseContractSuggestions(response, preview.source.title, request.markdown));
        } finally { window.clearTimeout(timer); }
      }
      setSuggestions({ source: preview.source, values: combineContractSuggestions(parts) });
      setPreview(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '연구 기준 후보를 찾지 못했습니다.'); }
    finally { controller.current = null; setRunning(false); setProgress(0); onBusyChange(false); }
  };

  return <section className="theory-suggestions" aria-label="AI 연구 기준 제안">
    <div className="theory-suggestions-header">
      <div className="theory-suggestions-title-group">
        <div className="theory-suggestions-badge">
          <Sparkles size={14} />
          <span>AI 도우미</span>
        </div>
        <h4>본문 기반 연구 기준 자동 도출</h4>
      </div>
      <button
        type="button"
        className="theory-suggestions-trigger-btn"
        aria-controls="theory-contract-fields"
        disabled={disabled || running || !title.trim() || !markdown.trim()}
        onClick={() => {
          onOpenCriteria();
          setError(''); setSuggestions(null); setSelected([]);
          try { setPreview({ source: { title, markdown, modelId }, requests: prepareContractSuggestionRequests(title, markdown) }); }
          catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : '전송 내용을 준비하지 못했습니다.'); }
        }}
      >
        <Sparkles size={14} />
        <span>AI로 연구 기준 후보 찾기</span>
      </button>
    </div>

    <p className="theory-suggestions-desc">{!title.trim() || !markdown.trim()
      ? '문서 제목과 본문을 입력하면 AI 도출 기능이 활성화됩니다.'
      : '제목과 본문을 스캔하여 연구 목적·공리·정의·기호·범위를 자동으로 찾아 제안합니다.'}</p>

    {previewCurrent && <section className="theory-suggestions-preview" aria-label="연구 기준 AI 전송 확인">
      <div className="theory-preview-header">
        <FileText size={15} />
        <h4>AI에 보낼 문서 확인</h4>
        <span className="theory-model-badge">모델: {modelId}</span>
      </div>
      <p className="theory-preview-info">
        본문 전체를 {preview.requests.length}개 구간으로 나누어 분석합니다. 각 구간마다 원문 근거가 명시된 가정·정의·기호·범위를 도출합니다.
      </p>

      <div className="theory-preview-sections">
        <strong>{preview.source.title}</strong>
        {preview.requests.map((request, index) => (
          <details key={index} open={preview.requests.length === 1} className="theory-preview-section-details">
            <summary>전송 구간 {index + 1} / {preview.requests.length}</summary>
            <pre>{request.markdown}</pre>
          </details>
        ))}
      </div>

      <div className="theory-preview-actions">
        <button type="button" className="theory-suggestions-start-btn" disabled={disabled || running} onClick={() => void start()}>
          <ArrowRight size={14} />
          <span>이 문서로 AI 제안 받기</span>
        </button>
      </div>
    </section>}

    {preview && !previewCurrent && <p className="theory-suggestions-warn">문서나 모델이 변경되었습니다. 전송 내용을 다시 확인해 주세요.</p>}

    {running && <div role="status" className="theory-suggestions-running">
      <Loader2 size={16} className="spin" />
      <span>AI가 연구 기준 후보를 찾는 중… ({progress} / {preview?.requests.length ?? 0} 구간)</span>
      <button type="button" className="theory-suggestions-abort-btn" onClick={() => controller.current?.abort()}>
        <XCircle size={13} />
        <span>중단</span>
      </button>
    </div>}

    {error && <div role="alert" className="theory-suggestions-error">
      <AlertCircle size={15} />
      <span>{error}</span>
    </div>}

    {suggestionsCurrent && <section className="theory-suggestions-results" aria-label="연구 기준 AI 제안 결과">
      <div className="theory-results-header">
        <CheckSquare size={16} />
        <h4>확인할 후보 {available.length}개 발견</h4>
      </div>

      {!available.length && <p className="theory-suggestions-empty">원문에서 명시적 연구 기준 후보를 찾지 못했습니다. 직접 작성하시거나 본문 표현을 보완해 보세요.</p>}

      <div className="theory-suggestions-choices">
        {available.map(key => {
          const suggestion = suggestions.values[key]!;
          const isSelected = selected.includes(key);
          return (
            <label className={`theory-suggestion-choice-card ${isSelected ? 'selected' : ''}`} key={key}>
              <input
                type="checkbox"
                checked={isSelected}
                onChange={event => setSelected(previous => event.target.checked ? [...previous, key] : previous.filter(item => item !== key))}
              />
              <div className="theory-choice-body">
                <div className="theory-choice-head">
                  <span className="theory-choice-label">{labels[key]}</span>
                  {contract[key].trim() && <span className="theory-choice-override-tag">기존 내용 덮어씀</span>}
                </div>
                <div className="theory-choice-text">{suggestion.text}</div>
                <div className="theory-choice-quote">원문: “{suggestion.quote}”</div>
                {contract[key].trim() && (
                  <div className="theory-choice-current">현재 입력: {contract[key]}</div>
                )}
              </div>
            </label>
          );
        })}
      </div>

      {!!available.length && (
        <div className="theory-suggestions-apply-bar">
          <button
            type="button"
            className="theory-suggestions-apply-btn"
            disabled={disabled || running || !selected.length}
            onClick={() => {
              onApply(suggestions.values, selected); setSuggestions(null); setSelected([]);
            }}
          >
            <Check size={15} />
            <span>선택한 {selected.length}개 기준 반영</span>
          </button>
          <p className="theory-suggestions-apply-note">반영 후 상단에서 확인하고 [저장]해야 버전에 보존됩니다.</p>
        </div>
      )}
    </section>}

    {suggestions && !suggestionsCurrent && <p className="theory-suggestions-warn">본문이 수정되어 이전 제안을 반영할 수 없습니다. 다시 시도해 주세요.</p>}
  </section>;
}

