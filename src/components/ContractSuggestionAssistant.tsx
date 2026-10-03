import { useRef, useState } from 'react';
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
    <div className="theory-suggestions-heading">
      <button type="button" aria-controls="theory-contract-fields" disabled={disabled || running || !title.trim() || !markdown.trim()} onClick={() => {
      onOpenCriteria();
      setError(''); setSuggestions(null); setSelected([]);
      try { setPreview({ source: { title, markdown, modelId }, requests: prepareContractSuggestionRequests(title, markdown) }); }
      catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : '전송 내용을 준비하지 못했습니다.'); }
      }}>AI로 연구 기준 찾기</button></div>
    <p>{!title.trim() || !markdown.trim()
      ? '문서 제목과 본문을 입력하면 버튼이 활성화됩니다.'
      : '제목과 본문에서 연구 기준 후보를 찾습니다. 원문 근거를 확인하고 선택한 항목만 반영하세요.'}</p>
    {previewCurrent && <section className="theory-suggestions-preview" aria-label="연구 기준 AI 전송 확인">
      <h4>AI에 보낼 문서 확인</h4>
      <p>모델: {modelId} · 본문 전체를 {preview.requests.length}개 구간으로 나누어 순서대로 전송합니다. 구간마다 AI 요청이 1회 발생합니다. 기존 대화·레퍼런스·PDF 원본은 포함되지 않습니다.</p>
      <p>요청: 각 구간에서 원문 인용이 있는 연구 목적·가정·정의·기호·범위·미해결 문제 후보를 찾습니다. 제외되는 본문 구간은 없습니다.</p>
      <strong>{preview.source.title}</strong>
      {preview.requests.map((request, index) => <details key={index} open={preview.requests.length === 1}>
        <summary>전송 구간 {index + 1}/{preview.requests.length}</summary>
        <pre>{request.markdown}</pre>
      </details>)}
      <button type="button" disabled={disabled || running} onClick={() => void start()}>이 문서로 AI 제안 받기</button>
    </section>}
    {preview && !previewCurrent && <p>문서나 모델이 바뀌었습니다. 전송 내용을 다시 확인해 주세요.</p>}
    {running && <div role="status">AI가 연구 기준 후보를 찾는 중… {progress}/{preview?.requests.length ?? 0}구간 <button type="button" onClick={() => controller.current?.abort()}>중단</button></div>}
    {error && <p role="alert" className="theory-error">{error}</p>}
    {suggestionsCurrent && <section aria-label="연구 기준 AI 제안 결과">
      <h4>확인할 후보 {available.length}개</h4>
      {!available.length && <p>원문에서 확인 가능한 연구 기준 후보를 찾지 못했습니다. 필요한 항목은 직접 작성할 수 있습니다.</p>}
      {available.map(key => {
        const suggestion = suggestions.values[key]!;
        return <label className="theory-suggestion-choice" key={key}>
          <input type="checkbox" checked={selected.includes(key)} onChange={event => setSelected(previous => event.target.checked ? [...previous, key] : previous.filter(item => item !== key))} />
          <span><strong>{labels[key]}</strong><span>{suggestion.text}</span><small>원문: “{suggestion.quote}”</small>
            {contract[key].trim() && <small>현재 입력: {contract[key]} · 선택하면 이 내용을 바꿉니다.</small>}</span>
        </label>;
      })}
      {!!available.length && <button type="button" disabled={disabled || running || !selected.length} onClick={() => {
        onApply(suggestions.values, selected); setSuggestions(null); setSelected([]);
      }}>선택한 연구 기준 반영</button>}
      <p>반영 후 문서를 저장해야 새 버전에 남습니다. AI 제안은 이론의 참이나 정합성 판정이 아닙니다.</p>
    </section>}
    {suggestions && !suggestionsCurrent && <p>본문이 바뀌어 이전 제안을 반영할 수 없습니다. 다시 찾아 주세요.</p>}
  </section>;
}
