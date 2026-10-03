import type { ReviewRun } from './reviewTypes';
import type { DocumentVersion, DocumentBlock } from './types';

export function reviewToMarkdown(run: ReviewRun, version: DocumentVersion, blocks: DocumentBlock[]) {
  if (version.id !== run.versionId || version.contentHash !== run.versionHash || blocks.some(block => block.versionId !== version.id)) throw new Error('검토 보고서의 원문 버전이 일치하지 않습니다.');
  const lines = [`# ${version.title} — 검토 기록`, '',
    `- 버전: v${version.number} / ${version.id}`, `- 본문 SHA-256: ${version.contentHash}`,
    `- 검사기: ${run.checker} / ${run.modelId ?? '로컬'}`, `- 상태: ${run.status} / ${run.outcome}`,
    `- 검사 블록: ${run.checkedBlockIds.length}/${run.checkedBlockIds.length + run.uncheckedBlockIds.length}`,
    `- 미검사 블록: ${run.uncheckedBlockIds.join(', ') || '없음'}`, '',
    '이 보고서는 기록된 검사 범위의 결과이며 참·완전 정합성·외부 호환성의 보증이 아니다. 사용자 주장 채택과 Issue 해결 표시는 증명이 아니다.', '',
    '## 연구 기준', '', ...(Object.entries(version.contract) as [string, string][]).flatMap(([key, value]) => [`### ${key}`, '', ...value.split('\n').map(line => `> ${line}`), '']),
    '## 검사 제한', '', ...run.limitations.map(text => `- ${text}`), ...(run.error ? [`- 실패: ${run.error}`] : []), '',
    '## 주장 후보', ''];
  if (run.graph) lines.push('## 전송 당시 승인 그래프', '', '목표와 추가 전제를 구분한다. 첨부는 검사 완료나 증명이 아니다. 외부 자료는 미전송.', '',
    '```json', JSON.stringify(run.graph, null, 2), '```', '');
  if (run.external) lines.push('## 독립 외부 원문 대조', '', `실제 대조 쌍: ${run.external.checkedPairIds.length}/${run.external.context.pairs.length}`, '',
    '모델 분류 후보이며 내부 논증 검사·관계 승인·참/완전 정합성 보증이 아니다. 파일 역할 표시는 학술적 독립성 보증이 아니다.', '',
    '```json', JSON.stringify(run.external, null, 2), '```', '');
  for (const claim of run.claims) lines.push(`### ${claim.kind} / ${claim.acceptance}`, '',
    `원문 블록 ${claim.blockId} / SHA-256 ${claim.blockHash} / ${claim.origin}`, '', ...claim.statement.split('\n').map(line => `> ${line}`), '');
  lines.push('## Issue와 수정 제안', '');
  for (const issue of run.issues) {
    lines.push(`### ${issue.severity} / ${issue.kind}`, '', issue.explanation, '', `해결 조건: ${issue.resolution}`, '',
      `상태: ${issue.resolvedByRunId ? `사용자 해결 표시 / 재검사 ${issue.resolvedByRunId}` : '미해결'}`, '');
    issue.quotes.forEach((quote, i) => lines.push(`원문 블록 ${issue.blockIds[i]}`, '', ...quote.split('\n').map(line => `> ${line}`), ''));
    for (const patch of run.patches.filter(patch => patch.issueIds.includes(issue.id))) {
      lines.push(`#### 수정 ${patch.id}`, '', `변경 전 hash: ${patch.beforeHash}`, `새 가정: ${patch.introducedAssumptions || '선언 없음 — 사용자 확인 필요'}`,
        `적용 버전: ${patch.appliedVersionId ?? '미적용'}`, '', '변경 전:', '',
        ...(blocks.find(block => block.id === patch.blockId)?.text ?? '').split('\n').map(line => `> ${line}`), '', '변경 후:', '',
        ...patch.replacement.split('\n').map(line => `> ${line}`), '');
      if (patch.impact) lines.push('수정 영향 범위 (적용 전 고정 승인 이력)', '', '과거 관계는 새 버전의 활성 승인/증명이 아니다. 첨부/범위 선택은 실제 재검사 완료가 아니다.', '',
        '```json', JSON.stringify(patch.impact, null, 2), '```', '');
    }
  }
  return lines.join('\n');
}
