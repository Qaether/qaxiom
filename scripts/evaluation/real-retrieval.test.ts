import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parseWorkspaceBundle } from '../../src/services/workspace';
import { evaluateLabelledRetrieval } from '../../src/services/retrieval/realEvaluation';

it('evaluates a local workspace backup against a separately authored, pinned label manifest', async () => {
  const backupPath = process.env.QAXIOM_EVAL_BACKUP;
  const labelsPath = process.env.QAXIOM_EVAL_LABELS;
  if (!backupPath || !labelsPath) throw new Error('QAXIOM_EVAL_BACKUP과 QAXIOM_EVAL_LABELS의 로컬 JSON 파일 경로를 지정하세요.');
  const backup = parseWorkspaceBundle(JSON.parse(await readFile(backupPath, 'utf8')));
  const labels = JSON.parse(await readFile(labelsPath, 'utf8'));
  const report = await evaluateLabelledRetrieval({ references: backup.data.references, referenceSpans: backup.data.referenceSpans }, labels);
  const { rows: _rows, ...summary } = report;
  console.info('Qaxiom labelled retrieval report (no source text)', JSON.stringify(summary, null, 2));
  expect(report.overall.leaks).toBe(0);
});
