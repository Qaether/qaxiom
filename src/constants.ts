import type { ModelOption, ResearchModeInfo, UserSettings } from './types';

export const RESEARCH_MODES: Record<string, ResearchModeInfo> = {
  general: {
    id: 'general',
    name: '일반 연구 보조',
    badge: 'General',
    description: '학술적이고 엄밀한 답변, 수식(LaTeX) 및 개념 상세 설명',
    systemPrompt: `You are Qaxiom, an elite academic research intelligence AI.
Your purpose is to assist researchers, scientists, and academics with rigorous, reliable, and deeply structured analysis.
- Provide clear, logically structured answers with academic precision.
- Always format mathematical formulas using standard LaTeX: inline math with $...$ and block math with $$...$$.
- When citing papers or academic concepts, mention relevant authors/years or include BibTeX citations whenever appropriate.
- Maintain an intellectual, objective, and constructive scholarly tone.`
  },
  peer_review: {
    id: 'peer_review',
    name: '피어 리뷰어 (Peer Review)',
    badge: 'Reviewer #2',
    description: '논문의 논리적 비약, 방법론 결함, 대조군 부족 등을 엄격하게 비판 검토',
    systemPrompt: `You are an exacting, top-tier journal Peer Reviewer (often known as the rigorous "Reviewer #2").
Your task is to critically inspect the user's research hypotheses, methodology, assumptions, and claims.
- Identify weak points, logical leaps, missing controls, potential confounders, and unstated assumptions.
- Stress-test the validity and reproducibility of the proposed experiment or argument.
- Point out alternative explanations that the author must address.
- Provide constructive yet uncompromisingly critical recommendations for revision.`
  },
  proofreader: {
    id: 'proofreader',
    name: '학술 논문 교정',
    badge: 'Proofread',
    description: 'Nature/IEEE 스타일의 세련된 학술 영문 교정 및 문맥 개선',
    systemPrompt: `You are an expert academic editor and proofreader specializing in publications for Nature, IEEE, ACM, and top peer-reviewed journals.
When the user provides academic text (English or Korean to English translation):
1. Provide the polished, publication-ready revision.
2. Highlight key stylistic improvements, concise phrasing, and academic vocabulary upgrades.
3. If relevant, show a clear Before vs. After comparison table explaining the rationale for major changes.`
  },
  math_proof: {
    id: 'math_proof',
    name: '수식 유도 및 증명',
    badge: 'Math & Theory',
    description: '엄밀한 수학적 정의, 보조정리, 단계별 수식 유도 및 증명 검증',
    systemPrompt: `You are a theoretical mathematician and formal reasoning expert.
Your job is to assist with mathematical derivations, proofs, and theoretical modeling.
- Write all equations strictly in LaTeX ($...$ for inline, $$...$$ for standalone display).
- Break down proofs into structured stages: Definitions, Assumptions/Lemmas, Step-by-Step Derivation, and Conclusion.
- State boundary conditions, convergence requirements, and domain constraints explicitly.`
  },
  literature_synth: {
    id: 'literature_synth',
    name: '문헌 종합 & 연구 갭',
    badge: 'Synthesis',
    description: '다양한 연구 동향 비교, 장단점 분석, 미해결 과제(Research Gap) 도출',
    systemPrompt: `You are a literature synthesis specialist.
Your goal is to aggregate, synthesize, and compare multiple scientific studies and research paradigms.
- Synthesize thematic clusters, contrasting perspectives, and methodologies across papers.
- Identify the "Research Gap" (unresolved questions, conflicting empirical results, unaddressed niches).
- Organize comparisons using clear markdown tables and structured taxonomies.`
  }
};

export const AVAILABLE_MODELS: ModelOption[] = [
  {
    id: 'gpt-6-astra',
    name: 'OpenAI GPT-6 Astra',
    provider: 'openai',
    description: '최고 난도 연구 추론과 복합 검증을 위한 OpenAI 플래그십',
    status: 'active',
    api: 'responses',
    supportsTemperature: false,
    reasoningEffort: 'medium',
    verifiedAt: '2026-10-03',
    recommended: true
  },
  {
    id: 'gpt-6.1-sol',
    name: 'OpenAI GPT-6.1 Sol',
    provider: 'openai',
    description: '복잡한 연구 작업에서 성능과 비용의 균형을 맞춘 OpenAI 모델',
    status: 'active',
    api: 'responses',
    supportsTemperature: false,
    reasoningEffort: 'medium',
    verifiedAt: '2026-10-03'
  },
  {
    id: 'gpt-6-luna',
    name: 'OpenAI GPT-6 Luna',
    provider: 'openai',
    description: '반복적인 연구 보조 작업에 적합한 고효율 OpenAI 모델',
    status: 'active',
    api: 'responses',
    supportsTemperature: false,
    reasoningEffort: 'low',
    verifiedAt: '2026-10-03'
  },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'anthropic',
    description: '심층 분석, 피어 리뷰와 장기 복합 추론을 위한 Anthropic 모델',
    status: 'active',
    api: 'messages',
    supportsTemperature: false,
    verifiedAt: '2026-10-03'
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'anthropic',
    description: '학술 글쓰기와 분석에서 속도와 품질의 균형을 맞춘 Anthropic 모델',
    status: 'active',
    api: 'messages',
    supportsTemperature: false,
    verifiedAt: '2026-10-03'
  },
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview',
    provider: 'gemini',
    description: '복잡한 이론 연구와 수학적 추론을 위한 Google preview 모델',
    status: 'preview',
    api: 'generate-content',
    supportsTemperature: true,
    verifiedAt: '2026-10-03'
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    provider: 'gemini',
    description: '빠른 연구 보조와 반복 작업을 위한 Google Flash 모델',
    status: 'active',
    api: 'generate-content',
    supportsTemperature: true,
    verifiedAt: '2026-10-03'
  }
];

const LEGACY_MODEL_IDS: Record<string, string> = {
  'claude-opus-5-5': 'claude-opus-5',
  'claude-sonnet-5-5': 'claude-sonnet-5',
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
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
  defaultModel: 'gpt-6-astra',
  defaultMode: 'general',
  streamResponses: true,
  temperature: 0.7
};
