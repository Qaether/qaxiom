// @vitest-environment jsdom

import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import DocumentAnalysisView from './DocumentAnalysisView';
import type { TheorySnapshot } from '../services/theory/types';
import type { AnalysisRun } from '../services/theory/analysis';

afterEach(cleanup);

const mockSnapshot: TheorySnapshot = {
  document: {
    id: 'doc-1',
    projectId: 'proj-1',
    role: 'theory',
    currentVersionId: 'ver-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  version: {
    id: 'ver-1',
    documentId: 'doc-1',
    number: 1,
    parentVersionId: null,
    restoredFromVersionId: null,
    title: '양자격자공간 이론 v1',
    markdown: '기존 진공의 정의에 모순이 존재한다.\n\nFCC 격자 구조에서 게이지 대칭성이 보존된다.',
    contentHash: 'hash-v1',
    contract: { purpose: '', assumptions: '', definitions: '', symbols: '', scope: '', openQuestions: '' },
    contractAnchors: {},
    createdAt: Date.now(),
  },
  blocks: [
    {
      id: 'blk-1',
      versionId: 'ver-1',
      documentId: 'doc-1',
      kind: 'paragraph',
      position: 0,
      startOffset: 0,
      endOffset: 21,
      text: '기존 진공의 정의에 모순이 존재한다.',
      contentHash: 'b-hash-1',
      predecessorIds: [],
    },
    {
      id: 'blk-2',
      versionId: 'ver-1',
      documentId: 'doc-1',
      kind: 'paragraph',
      position: 1,
      startOffset: 23,
      endOffset: 50,
      text: 'FCC 격자 구조에서 게이지 대칭성이 보존된다.',
      contentHash: 'b-hash-2',
      predecessorIds: [],
    },
  ],
  history: [],
};

const mockRun: AnalysisRun = {
  id: 'run-1',
  documentId: 'doc-1',
  versionId: 'ver-1',
  versionHash: 'hash-v1',
  modelId: 'gemini-2.5-flash',
  status: 'complete',
  limitations: ['검토 한계 예시'],
  checkedBlockIds: ['blk-1'],
  error: '',
  findings: [
    {
      id: 'f-1',
      blockId: 'blk-1',
      quote: '기존 진공의 정의에 모순이 존재한다.',
      explanation: '진공 정의의 모순 범위를 명확히 한정해야 합니다.',
      resolution: '국소 게이지 장 하에서의 진공 정의로 한정할 것',
      replacement: '국소 게이지 장 하에서의 진공 정의에 모순이 존재한다.',
      decision: 'open',
    },
  ],
  createdAt: Date.now(),
};

describe('DocumentAnalysisView', () => {
  it('defaults to diff-centric view mode and renders diff side-by-side', () => {
    render(
      <DocumentAnalysisView
        snapshot={mockSnapshot}
        run={mockRun}
        onDecision={vi.fn()}
        onApply={vi.fn()}
        canApply={true}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    // Diff 모아보기가 기본 활성화되어 있는지 확인
    expect(screen.getByText(/Diff 모아보기/)).toBeDefined();
    expect(screen.getByText(/진공 정의의 모순 범위를 명확히 한정해야 합니다/)).toBeDefined();

    // 1-클릭 결정 버튼 노출 확인
    expect(screen.getByRole('button', { name: /편집 내용에 적용/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /기각/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /나중에/ })).toBeDefined();
  });

  it('calls onApply when 1-click apply button is clicked', () => {
    const handleApply = vi.fn();
    render(
      <DocumentAnalysisView
        snapshot={mockSnapshot}
        run={mockRun}
        onDecision={vi.fn()}
        onApply={handleApply}
        canApply={true}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const applyBtn = screen.getByRole('button', { name: /편집 내용에 적용/ });
    fireEvent.click(applyBtn);

    expect(handleApply).toHaveBeenCalledTimes(1);
    expect(handleApply).toHaveBeenCalledWith(mockRun.findings[0]);
  });

  it('renders history dropdown and notifies onSelectHistory when multiple runs exist', () => {
    const handleSelectHistory = vi.fn();
    const olderRun: AnalysisRun = {
      ...mockRun,
      id: 'run-0',
      createdAt: Date.now() - 3600000,
    };

    render(
      <DocumentAnalysisView
        snapshot={mockSnapshot}
        run={mockRun}
        history={[mockRun, olderRun]}
        onSelectHistory={handleSelectHistory}
        onDecision={vi.fn()}
        onApply={vi.fn()}
        canApply={true}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const select = screen.getByTitle('이전 정합성 분석 결과 보기');
    expect(select).toBeDefined();

    fireEvent.change(select, { target: { value: 'run-0' } });
    expect(handleSelectHistory).toHaveBeenCalledWith(olderRun);
  });

  it('calls onDelete when delete button is clicked and confirmed via inline confirm UI', () => {
    const handleDelete = vi.fn();

    render(
      <DocumentAnalysisView
        snapshot={mockSnapshot}
        run={mockRun}
        onDecision={vi.fn()}
        onApply={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onDelete={handleDelete}
        canApply={true}
      />
    );

    const deleteBtn = screen.getByRole('button', { name: /삭제/ });
    fireEvent.click(deleteBtn);

    const confirmBtn = screen.getByRole('button', { name: /확인/ });
    fireEvent.click(confirmBtn);

    expect(handleDelete).toHaveBeenCalledTimes(1);
    expect(handleDelete).toHaveBeenCalledWith(mockRun);
  });
});
