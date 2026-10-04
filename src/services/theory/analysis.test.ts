// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { QaxiomDatabase } from '../database';
import { createTheory, saveTheoryVersion } from './documents';
import { EMPTY_CONTRACT } from './types';
import { applyAnalysisSuggestion, parseDocumentAnalysis, prepareDocumentAnalysis, setAnalysisDecision } from './analysis';
import { createWorkspaceBundle, restoreWorkspaceBundle } from '../workspace';

let db: QaxiomDatabase;
beforeEach(() => { db = new QaxiomDatabase(`analysis-${crypto.randomUUID()}`); });
afterEach(async () => { await db.delete(); });

it('sends the complete canonical document and anchors a suggestion to exact source text', async () => {
  const longText = '검토할 내용'.repeat(5000);
  const snapshot = await createTheory({ title: '전체 분석', markdown: `# 가정\n\nx > 0\n\n# 주장\n\n모든 실수에서 참이다.\n\n${longText}`, contract: { ...EMPTY_CONTRACT } }, db);
  const request = await prepareDocumentAnalysis(snapshot);
  const payload = JSON.parse(request.split('research_document=')[1]);
  expect(payload.markdown).toBe(snapshot.version.markdown);
  expect(new TextEncoder().encode(request).byteLength).toBeGreaterThan(40000);
  const block = snapshot.blocks.find(item => item.text.includes('모든 실수'))!;
  const result = parseDocumentAnalysis(JSON.stringify({ checkedBlockIds: snapshot.blocks.map(item => item.id), limitations: [],
    findings: [{ blockId: block.id, quote: '모든 실수', explanation: '범위가 가정과 충돌합니다.', resolution: '양수 범위를 확인하세요.', replacement: '양수 실수에서 참이다.\n' }] }), snapshot, 'test-model');
  expect(result.findings).toHaveLength(1);
  expect(applyAnalysisSuggestion(snapshot.version.markdown, snapshot, result, result.findings[0])).toContain('양수 실수에서 참이다.');
  expect(() => applyAnalysisSuggestion(`${snapshot.version.markdown}변경`, snapshot, result, result.findings[0])).toThrow('달라졌습니다');
  await db.analysis_runs.add(result);
  await setAnalysisDecision(result.id, result.findings[0].id, 'dismissed', db);
  expect((await db.analysis_runs.get(result.id))!.findings[0].decision).toBe('dismissed');
  const target = new QaxiomDatabase(`analysis-restore-${crypto.randomUUID()}`);
  try {
    const backup = await createWorkspaceBundle(db);
    await restoreWorkspaceBundle(backup, target);
    expect((await target.analysis_runs.get(result.id))!.findings[0].decision).toBe('dismissed');
    const legacy = structuredClone(backup) as unknown as { version: number; data: { analysisRuns?: unknown } };
    legacy.version = 23;
    delete legacy.data.analysisRuns;
    await restoreWorkspaceBundle(legacy, target);
    expect(await target.analysis_runs.count()).toBe(0);
  } finally { await target.delete(); }
});

it('rejects invented quotes and keeps earlier analysis bound to its original version', async () => {
  const snapshot = await createTheory({ title: '문서', markdown: '원래 주장', contract: { ...EMPTY_CONTRACT } }, db);
  const block = snapshot.blocks[0];
  const response = { checkedBlockIds: [block.id], limitations: [], findings: [
    { blockId: block.id, quote: '없는 문장', explanation: '이유', resolution: '확인', replacement: null as string | null }
  ] };
  expect(() => parseDocumentAnalysis(JSON.stringify(response), snapshot, 'test')).toThrow('원문 연결');
  response.findings[0].quote = '원래 주장';
  response.findings[0].replacement = '새 주장';
  const run = parseDocumentAnalysis(JSON.stringify(response), snapshot, 'test');
  const next = await saveTheoryVersion(snapshot.document.id, snapshot.version.id, { title: '문서', markdown: '수정된 주장', contract: snapshot.version.contract }, db);
  expect(() => applyAnalysisSuggestion(next.version.markdown, next, run, run.findings[0])).toThrow('달라졌습니다');
});
