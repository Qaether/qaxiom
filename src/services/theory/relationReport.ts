import type { loadRelationWiki } from './relations';
import { anchorKey } from './relationTypes';
import { relationGraph } from './relationGraph';
import { spanLocation } from '../retrieval/pdfTypes';

export function relationWikiToMarkdown(wiki: Awaited<ReturnType<typeof loadRelationWiki>>) {
  const lines = ['# Research Wiki — 원문 고정 관계', '', `정본 ${wiki.snapshot.version.title} · v${wiki.snapshot.version.number} · ${wiki.snapshot.version.id}`,
    `정본 SHA-256 ${wiki.snapshot.version.contentHash}`, '', '이 문서는 정본/원문과 승인 관계의 파생 뷰입니다. 사용자 채택·관계·대조 분류는 참·증명·정합성 보증이 아닙니다. 메모/자체 문서는 독립 외부 증거가 아닙니다. 선언하지 않은 관계는 포함하지 않습니다.', ''];
  const active = wiki.entries.filter(e => e.status === 'active').map(e => e.relation);
  for (const run of wiki.runs) for (const claim of run.claims) {
    const key = anchorKey({ type: 'claim', runId: run.id, claimId: claim.id, versionId: run.versionId, versionHash: run.versionHash, blockId: claim.blockId, blockHash: claim.blockHash, quote: claim.statement });
    const graph = relationGraph(active, key);
    lines.push(`## Claim ${claim.id}`, '', `검토 ${run.id} · 버전 ${run.versionId} · 블록 ${claim.blockId} · hash ${claim.blockHash} · ${claim.kind}/${claim.acceptance}`,
      ...claim.statement.split('\n').map(line => `> ${line}`), '', `현재 역참조: ${graph.incoming.map(r => r.id).join(', ') || '없음'} · 의존 전제 ${graph.dependencies.length} · 수정 영향 ${graph.impacted.length}`, '');
  }
  const cycle = relationGraph(active, '').proofCycleRelationIds;
  lines.push(`승인 증명 의존성 순환 후보: ${cycle.join(', ') || '없음'} (개념 순환은 오류 아님)`, '', '## 승인 관계와 이력', '');
  for (const entry of wiki.entries) {
    const r = entry.relation;
    lines.push(`### Relation ${r.id}`, '', `${r.kind}/${r.dependencyType ?? '해당 없음'} · ${entry.status} · SHA-256 ${r.relationHash}`,
      `출발 검토 ${r.from.runId} · Claim ${r.from.claimId} · 버전 ${r.from.versionId} · 블록 ${r.from.blockId}`,
      '', ...r.from.quote.split('\n').map(line => `> ${line}`), '', '연결 원문:', ...r.to.quote.split('\n').map(line => `> ${line}`), '', `승인 사유: ${r.note}`, '');
    if (r.to.type === 'claim') lines.push(`도착 검토 ${r.to.runId} · Claim ${r.to.claimId} · 버전 ${r.to.versionId} · 블록 ${r.to.blockId}`, '');
    else {
      const target = r.to, span = wiki.spans.find(s => s.id === target.spanId);
      lines.push(`원문: ${entry.source?.name ?? '없음'} · ${target.sourceId} · ${target.spanId} · ${span ? spanLocation(span) : '위치 미확인'} · SHA-256 ${target.sourceHash}`,
        `독립 외부 자료: ${entry.independent ? '예' : '아니오 — 메모/자체 문서'}`, '');
      if (r.assessment) lines.push(`사용자 대조: ${r.assessment.label}`, `자체 조건: ${r.assessment.theoryConditions}`, `원문 조건: ${r.assessment.referenceConditions}`, '');
    }
    if (r.retractedAt !== null) lines.push(`철회 ${new Date(r.retractedAt).toISOString()} · 사유: ${r.retractionNote}`, '');
    if (r.externalReviewOrigin) lines.push('외부 대조에서 별도 사용자 승인 (내부 정합성 통과 아님):', JSON.stringify(r.externalReviewOrigin), '');
  }
  return lines.join('\n');
}
