// @vitest-environment jsdom

import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    title: 'Quantum Lattice Space Theory v1',
    markdown: 'There is a contradiction in the existing definition of vacuum.\n\nGauge symmetry is preserved in the FCC lattice structure.',
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
      endOffset: 59,
      text: 'There is a contradiction in the existing definition of vacuum.',
      contentHash: 'b-hash-1',
      predecessorIds: [],
    },
    {
      id: 'blk-2',
      versionId: 'ver-1',
      documentId: 'doc-1',
      kind: 'paragraph',
      position: 1,
      startOffset: 61,
      endOffset: 118,
      text: 'Gauge symmetry is preserved in the FCC lattice structure.',
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
  limitations: ['Example review limitation'],
  checkedBlockIds: ['blk-1'],
  error: '',
  findings: [
    {
      id: 'f-1',
      blockId: 'blk-1',
      quote: 'There is a contradiction in the existing definition of vacuum.',
      explanation: 'The scope of the contradiction in the vacuum definition must be clearly bounded.',
      resolution: 'Restrict to the vacuum definition under a local gauge field',
      replacement: 'There is a contradiction in the vacuum definition under a local gauge field.',
      decision: 'open',
    },
  ],
  createdAt: Date.now(),
};

describe('DocumentAnalysisView', () => {
  it('renders full document context view and findings', () => {
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

    expect(screen.getByText(/The scope of the contradiction in the vacuum definition must be clearly bounded/)).toBeDefined();

    // Verify 1-click decision buttons are visible
    expect(screen.getByRole('button', { name: /Apply to draft/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Dismiss/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Later/ })).toBeDefined();
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

    const applyBtn = screen.getByRole('button', { name: /Apply to draft/ });
    fireEvent.click(applyBtn);

    expect(handleApply).toHaveBeenCalledTimes(1);
    expect(handleApply).toHaveBeenCalledWith(mockRun.findings[0]);
  });

  it('renders analysis math by default and switches to source text without changing the diff', async () => {
    const mathRun: AnalysisRun = {
      ...mockRun,
      findings: [{ ...mockRun.findings[0], explanation: 'Check energy $E=mc^2$.', replacement: 'Verify energy $E=mc^2$.' }]
    };
    const { container } = render(
      <DocumentAnalysisView snapshot={mockSnapshot} run={mathRun} onDecision={vi.fn()} onApply={vi.fn()}
        canApply onRetry={vi.fn()} onCancel={vi.fn()} />
    );
    await waitFor(() => expect(container.querySelectorAll('mjx-container.MathJax').length).toBeGreaterThan(0));
    expect(screen.getByText('Suggested revision math preview')).toBeDefined();
    expect(screen.getByLabelText('Compare original and suggested revision')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'View Source' }));
    expect(screen.getByRole('button', { name: 'Render Math' })).toBeDefined();
    expect(screen.getByText('Check energy $E=mc^2$.')).toBeDefined();
    expect(screen.queryByText('Suggested revision math preview')).toBeNull();
  });

  it('shows live progress and a provider summary above the result, then collapses it on completion', () => {
    const progress = { runId: mockRun.id, stage: 'Receiving results', startedAt: Date.now(), receivedChars: 120, reasoningSummary: 'Checking premises and equations.' };
    const { container, rerender } = render(
      <DocumentAnalysisView snapshot={mockSnapshot} run={{ ...mockRun, status: 'running' }} progress={progress}
        onDecision={vi.fn()} onApply={vi.fn()} canApply onRetry={vi.fn()} onCancel={vi.fn()} />
    );
    expect(container.querySelector('.document-analysis-progress')).toHaveProperty('open', true);
    expect(screen.getByText('Model reasoning summary')).toBeDefined();
    expect(screen.getByText('Checking premises and equations.')).toBeDefined();
    rerender(
      <DocumentAnalysisView snapshot={mockSnapshot} run={mockRun} progress={{ ...progress, stage: 'Analysis complete' }}
        onDecision={vi.fn()} onApply={vi.fn()} canApply onRetry={vi.fn()} onCancel={vi.fn()} />
    );
    expect(container.querySelector('.document-analysis-progress')).toHaveProperty('open', false);
    expect(screen.getByRole('button', { name: 'View Source' })).toBeDefined();
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

    const select = screen.getByTitle('View previous consistency analysis results');
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

    const deleteBtn = screen.getByRole('button', { name: /Delete/ });
    fireEvent.click(deleteBtn);

    const confirmBtn = screen.getByRole('button', { name: /Confirm/ });
    fireEvent.click(confirmBtn);

    expect(handleDelete).toHaveBeenCalledTimes(1);
    expect(handleDelete).toHaveBeenCalledWith(mockRun);
  });
});
