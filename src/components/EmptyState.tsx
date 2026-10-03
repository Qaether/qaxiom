import React from 'react';
import { Sigma, SearchCheck, Sparkles, BookOpen, Cpu, ShieldCheck } from 'lucide-react';
import type { ResearchMode } from '../types';
import { RESEARCH_MODES } from '../constants';

interface EmptyStateProps {
  onSelectPrompt: (prompt: string) => void;
  currentMode: ResearchMode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ onSelectPrompt, currentMode }) => {
  const modeInfo = RESEARCH_MODES[currentMode] || RESEARCH_MODES.general;

  const starterCards = [
    {
      icon: <Sigma size={20} className="card-icon sigma" />,
      title: '수식 유도 및 증명',
      description: '슈뢰딩거 파동 방정식의 1차원 시간 비의존 형태 유도 과정과 물리적 의미 설명',
      prompt: '슈뢰딩거 파동 방정식의 1차원 시간 비의존 형태의 유도 과정과 각 항의 물리적 의미를 엄밀한 단계별 수식($...$, $$...$$)으로 설명해 줘.'
    },
    {
      icon: <SearchCheck size={20} className="card-icon review" />,
      title: '가설 피어 리뷰 (Reviewer #2)',
      description: '트랜스포머의 어텐션 메커니즘을 O(N) 상태공간 모델로 대체할 때의 위험성과 대조군 검증',
      prompt: '논문 피어 리뷰어 관점에서, 트랜스포머의 셀프 어텐션을 O(N) 선형 복잡도 모델로 대체하려는 연구 설계의 취약점과 반드시 수행해야 할 ablation study 및 대조군(Control group)을 지적해 줘.'
    },
    {
      icon: <Sparkles size={20} className="card-icon proof" />,
      title: '학술 논문 영문 교정',
      description: 'Nature/IEEE 스타일에 맞춘 학술 초록(Abstract)의 명확성 개선 및 전문 어휘 교체',
      prompt: '다음 연구 초록을 Nature 수준의 학술 영문으로 교정하고, 문맥 개선점 및 교체된 전문 어휘(Vocabulary)를 Before/After 테이블로 정리해 줘:\n"We proposed a new method to make neural networks learn faster. In our test, the speed became 2 times faster without losing accuracy."'
    },
    {
      icon: <BookOpen size={20} className="card-icon bibtex" />,
      title: '문헌 종합 & BibTeX',
      description: '최신 프론티어 모델의 추론 방식 비교 및 BibTeX 레퍼런스 생성',
      prompt: 'GPT-6, Claude 5, Gemini 3 계열의 공개 기술 문서를 근거로 추론 방식과 연구 활용상의 차이를 비교하고, 검증 가능한 출처만 BibTeX 인용 양식으로 작성해 줘.'
    }
  ];

  return (
    <div className="empty-state-container">
      <div className="empty-hero">
        <div className="hero-icon-wrapper">
          <Cpu size={36} className="hero-icon" />
        </div>
        <h1 className="hero-title">Qaxiom Research Intelligence</h1>
        <p className="hero-subtitle">
          서버 없는 순수 브라우저 기반(Zero-Backend) 로컬 연구 도우미.<br />
          수식 증명, 논문 피어 리뷰, 학술 교정, 그리고 개인 연구 위키 지식 체계.
        </p>
        <div className="current-mode-indicator">
          <span>현재 적용 모드: </span>
          <strong className="indicator-badge">{modeInfo.name}</strong>
          <span className="indicator-desc">— {modeInfo.description}</span>
        </div>
      </div>

      <div className="starter-grid">
        {starterCards.map((card, idx) => (
          <div
            key={idx}
            className="starter-card"
            onClick={() => onSelectPrompt(card.prompt)}
          >
            <div className="card-top">
              {card.icon}
              <h4>{card.title}</h4>
            </div>
            <p className="card-desc">{card.description}</p>
            <span className="card-hint">클릭하여 시작하기 →</span>
          </div>
        ))}
      </div>

      <div className="privacy-pill">
        <ShieldCheck size={14} className="privacy-icon" />
        <span>데이터는 이 브라우저에 저장됩니다. 질문과 선택한 원문은 선택 AI 제공사로 전송됩니다.</span>
      </div>
    </div>
  );
};
