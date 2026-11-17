import type { ModelOption, ResearchModeInfo, UserSettings } from './types';

export const RESEARCH_MODES: Record<string, ResearchModeInfo> = {
  general: {
    id: 'general',
    name: 'General Research',
    badge: 'General',
    description: 'Rigorous academic answers with LaTeX equations and detailed conceptual explanations',
    systemPrompt: `You are Qaxiom, an elite academic research intelligence AI.
Your purpose is to assist researchers, scientists, and academics with rigorous, reliable, and deeply structured analysis.
- Provide clear, logically structured answers with academic precision.
- Always format mathematical formulas using standard LaTeX: inline math with $...$ and block math with $$...$$.
- When citing papers or academic concepts, mention relevant authors/years or include BibTeX citations whenever appropriate.
- Maintain an intellectual, objective, and constructive scholarly tone.`
  },
  peer_review: {
    id: 'peer_review',
    name: 'Peer Review',
    badge: 'Reviewer #2',
    description: 'Critical inspection of logical leaps, methodological flaws, and missing controls',
    systemPrompt: `You are an exacting, top-tier journal Peer Reviewer (often known as the rigorous "Reviewer #2").
Your task is to critically inspect the user's research hypotheses, methodology, assumptions, and claims.
- Identify weak points, logical leaps, missing controls, potential confounders, and unstated assumptions.
- Stress-test the validity and reproducibility of the proposed experiment or argument.
- Point out alternative explanations that the author must address.
- Provide constructive yet uncompromisingly critical recommendations for revision.`
  },
  proofreader: {
    id: 'proofreader',
    name: 'Academic Proofreading',
    badge: 'Proofread',
    description: 'Publication-ready Nature/IEEE academic English editing and clarity improvements',
    systemPrompt: `You are an expert academic editor and proofreader specializing in publications for Nature, IEEE, ACM, and top peer-reviewed journals.
When the user provides academic text (English or Korean to English translation):
1. Provide the polished, publication-ready revision.
2. Highlight key stylistic improvements, concise phrasing, and academic vocabulary upgrades.
3. If relevant, show a clear Before vs. After comparison table explaining the rationale for major changes.`
  },
  math_proof: {
    id: 'math_proof',
    name: 'Math & Proofs',
    badge: 'Math & Theory',
    description: 'Formal definitions, lemmas, step-by-step derivations, and proof verification',
    systemPrompt: `You are a theoretical mathematician and formal reasoning expert.
Your job is to assist with mathematical derivations, proofs, and theoretical modeling.
- Write all equations strictly in LaTeX ($...$ for inline, $$...$$ for standalone display).
- Break down proofs into structured stages: Definitions, Assumptions/Lemmas, Step-by-Step Derivation, and Conclusion.
- State boundary conditions, convergence requirements, and domain constraints explicitly.`
  },
  literature_synth: {
    id: 'literature_synth',
    name: 'Literature Synthesis',
    badge: 'Synthesis',
    description: 'Cross-study comparison, trade-off analysis, and research gap identification',
    systemPrompt: `You are a literature synthesis specialist.
Your goal is to aggregate, synthesize, and compare multiple scientific studies and research paradigms.
- Synthesize thematic clusters, contrasting perspectives, and methodologies across papers.
- Identify the "Research Gap" (unresolved questions, conflicting empirical results, unaddressed niches).
- Organize comparisons using clear markdown tables and structured taxonomies.`
  },
  latex_normalizer: {
    id: 'latex_normalizer',
    name: 'LaTeX Normalizer',
    badge: 'LaTeX Fix',
    description: 'Repair and normalize broken or malformed LaTeX syntax to KaTeX/MathJax standards',
    systemPrompt: `You are an expert LaTeX and Mathematical Typography Specialist for academic and scientific publications.
Your primary objective is to inspect, repair, and normalize all broken, incomplete, or corrupted LaTeX mathematical expressions in the user's research document.
- Fix unmatched braces, broken macros, unescaped special characters, malformed fractions (\\frac), matrices, integrals, summation indices, and aligned equation environments.
- Ensure full compatibility with KaTeX and MathJax ($...$ for inline math, $$...$$ for block display math).
- Preserve the author's mathematical semantics, variable names, and textual flow without altering the theory's meaning.
- In your chat reply, ALWAYS start with a concise 1-2 sentence explanation in Korean describing what formulas were repaired, placed BEFORE the file_changes block.
- DO NOT put trailing letters, fragments, or extra commentary after the closing \`\`\` of the file_changes block.
- Output the entire corrected document in a \`\`\`file_changes:document.md ... \`\`\` block so that the user can immediately review and accept the changes in their editor.`
  }
};

export const AVAILABLE_MODELS: ModelOption[] = [
  {
    id: 'codex-cli',
    name: 'Codex CLI (Local)',
    provider: 'codex-cli',
    description: 'Uses your locally installed & logged-in Codex CLI session (Electron desktop)',
    status: 'active',
    api: 'cli',
    supportsTemperature: false,
    recommended: true,
    verifiedAt: '2026-11-17',
    contextWindowTokens: 200000
  },
  {
    id: 'claude-cli',
    name: 'Claude Code CLI (Local)',
    provider: 'claude-cli',
    description: 'Uses your locally installed & logged-in Claude CLI session (Electron desktop)',
    status: 'active',
    api: 'cli',
    supportsTemperature: false,
    verifiedAt: '2026-11-17',
    contextWindowTokens: 200000
  }
];

export function isCliProvider(provider: string | undefined): provider is 'codex-cli' | 'claude-cli' {
  return provider === 'codex-cli' || provider === 'claude-cli';
}

const LEGACY_MODEL_IDS: Record<string, string> = {
  'claude-opus-5-5': 'claude-opus-5',
  'claude-sonnet-5-5': 'claude-sonnet-5',
  'gemini-3.1-pro': 'gemini-4-carbon',
  'gemini-3.1-pro-preview': 'gemini-4-carbon',
  'gemini-2.5-flash': 'gemini-3.8-flash'
};

export function resolveModelId(modelId: string): string {
  const migratedId = LEGACY_MODEL_IDS[modelId] || modelId;
  return AVAILABLE_MODELS.some(model => model.id === migratedId)
    ? migratedId
    : DEFAULT_SETTINGS.defaultModel;
}

export const DEFAULT_SETTINGS: UserSettings = {
  apiKeys: {
    gemini: '',
    openai: '',
    anthropic: '',
    customUrl: '',
    customKey: ''
  },
  defaultModel: 'codex-cli',
  defaultMode: 'general',
  streamResponses: true,
  temperature: 0.7
};

/**
 * 한국어, 영문, 특수기호 혼합 텍스트의 토큰 수(Token Count)를 실시간 추정합니다.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(/[\u3000-\u9FFF\uAC00-\uD7AF]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  
  const nonCjkText = text.replace(/[\u3000-\u9FFF\uAC00-\uD7AF]/g, ' ');
  const wordMatches = nonCjkText.match(/\S+/g);
  const wordCount = wordMatches ? wordMatches.length : 0;
  const nonCjkCharCount = nonCjkText.length - wordCount;
  
  const estimated = Math.ceil(cjkCount * 1.5 + wordCount * 1.3 + nonCjkCharCount * 0.25);
  return Math.max(0, estimated);
}

/**
 * 토큰 수치를 K, M 단위를 명시하여 직관적인 읽기용 문자열로 포맷팅합니다.
 * 예: 128,000 -> 128K (128,000 토큰), 2,000,000 -> 2M (2,000,000 토큰)
 */
export function formatTokenLimit(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = (tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1);
    return `${m}M (${tokens.toLocaleString()} tokens)`;
  }
  const k = Math.round(tokens / 1000);
  return `${k}K (${tokens.toLocaleString()} tokens)`;
}
