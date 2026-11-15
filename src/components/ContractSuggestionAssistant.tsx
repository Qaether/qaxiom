import { useRef, useState } from 'react';
import { Sparkles, Check, Loader2, AlertCircle, FileText, CheckSquare, XCircle, ArrowRight } from 'lucide-react';
import { runTurn } from '../harness/runTurn';
import { combineContractSuggestions, CONTRACT_KEYS, parseContractSuggestions, prepareContractSuggestionRequests, type ContractKey, type ContractSuggestions } from '../services/theory/contractSuggestions';
import type { ResearchContract } from '../services/theory/types';
import type { UserSettings } from '../types';

const labels: Record<ContractKey, string> = {
  purpose: 'Purpose', assumptions: 'Assumptions & Axioms', definitions: 'Key Definitions',
  symbols: 'Symbols', scope: 'Scope', openQuestions: 'Open Questions'
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
        if (abort.signal.aborted) throw new Error('AI research criteria extraction was aborted.');
        setProgress(index + 1);
        const result = await runTurn(
          {
            kind: 'contract_suggestion',
            messages: [{ id: crypto.randomUUID(), role: 'user', content: request.prompt, timestamp: Date.now() }],
            modelId: preview.source.modelId,
            researchMode: 'general',
            settings
          },
          { signal: abort.signal }
        );
        if (result.aborted) {
          throw new Error('AI research criteria extraction was aborted or timed out.');
        }
        parts.push(parseContractSuggestions(result.text, preview.source.title, request.markdown));
      }
      setSuggestions({ source: preview.source, values: combineContractSuggestions(parts) });
      setPreview(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to find research criteria candidates.'); }
    finally { controller.current = null; setRunning(false); setProgress(0); onBusyChange(false); }
  };

  return <section className="theory-suggestions" aria-label="AI research criteria suggestions">
    <div className="theory-suggestions-header">
      <div className="theory-suggestions-title-group">
        <div className="theory-suggestions-badge">
          <Sparkles size={14} />
          <span>AI Assistant</span>
        </div>
        <h4>Auto-extract research criteria from body</h4>
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
          catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : 'Failed to prepare transmission content.'); }
        }}
      >
        <Sparkles size={14} />
        <span>Find criteria candidates with AI</span>
      </button>
    </div>

    <p className="theory-suggestions-desc">{!title.trim() || !markdown.trim()
      ? 'Enter a document title and body to enable AI extraction.'
      : 'Scans the title and body to automatically suggest research purpose, axioms, definitions, symbols, and scope.'}</p>

    {previewCurrent && <section className="theory-suggestions-preview" aria-label="Confirm AI research criteria transmission">
      <div className="theory-preview-header">
        <FileText size={15} />
        <h4>Confirm document to send to AI</h4>
        <span className="theory-model-badge">Model: {modelId}</span>
      </div>
      <p className="theory-preview-info">
        Analyzes the full body in {preview.requests.length} section(s), extracting assumptions, definitions, symbols, and scope with source quotes.
      </p>

      <div className="theory-preview-sections">
        <strong>{preview.source.title}</strong>
        {preview.requests.map((request, index) => (
          <details key={index} open={preview.requests.length === 1} className="theory-preview-section-details">
            <summary>Section {index + 1} / {preview.requests.length}</summary>
            <pre>{request.markdown}</pre>
          </details>
        ))}
      </div>

      <div className="theory-preview-actions">
        <button type="button" className="theory-suggestions-start-btn" disabled={disabled || running} onClick={() => void start()}>
          <ArrowRight size={14} />
          <span>Get AI suggestions for this document</span>
        </button>
      </div>
    </section>}

    {preview && !previewCurrent && <p className="theory-suggestions-warn">Document or model has changed. Please review the transmission content again.</p>}

    {running && <div role="status" className="theory-suggestions-running">
      <Loader2 size={16} className="spin" />
      <span>Finding research criteria candidates with AI… ({progress} / {preview?.requests.length ?? 0} sections)</span>
      <button type="button" className="theory-suggestions-abort-btn" onClick={() => controller.current?.abort()}>
        <XCircle size={13} />
        <span>Abort</span>
      </button>
    </div>}

    {error && <div role="alert" className="theory-suggestions-error">
      <AlertCircle size={15} />
      <span>{error}</span>
    </div>}

    {suggestionsCurrent && <section className="theory-suggestions-results" aria-label="AI research criteria suggestion results">
      <div className="theory-results-header">
        <CheckSquare size={16} />
        <h4>Found {available.length} candidate(s) to review</h4>
      </div>

      {!available.length && <p className="theory-suggestions-empty">No explicit research criteria candidates found in the source text. Try writing them directly or clarifying the body text.</p>}

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
                  {contract[key].trim() && <span className="theory-choice-override-tag">Overwrites existing</span>}
                </div>
                <div className="theory-choice-text">{suggestion.text}</div>
                <div className="theory-choice-quote">Source: &ldquo;{suggestion.quote}&rdquo;</div>
                {contract[key].trim() && (
                  <div className="theory-choice-current">Current value: {contract[key]}</div>
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
            <span>Apply {selected.length} selected criteria</span>
          </button>
          <p className="theory-suggestions-apply-note">Review at the top and click [Save] to preserve changes in a version.</p>
        </div>
      )}
    </section>}

    {suggestions && !suggestionsCurrent && <p className="theory-suggestions-warn">The body has been modified, so previous suggestions cannot be applied. Please try again.</p>}
  </section>;
}

