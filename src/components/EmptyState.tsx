import React from 'react';
import { Cpu } from 'lucide-react';
import type { ResearchMode } from '../types';

interface EmptyStateProps {
  onSelectPrompt?: (prompt: string) => void;
  currentMode?: ResearchMode;
}

export const EmptyState: React.FC<EmptyStateProps> = () => {
  return (
    <div className="empty-state-container empty-state-clean">
      <h2 className="sr-only">Qaxiom Research Intelligence</h2>
      <div className="empty-hero-clean">
        <div className="hero-icon-clean">
          <Cpu size={36} />
        </div>
        <p className="empty-clean-prompt">연구 주제나 가설에 대해 질문해 보세요</p>
      </div>
    </div>
  );
};
