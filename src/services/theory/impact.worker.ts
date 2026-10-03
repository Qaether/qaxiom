import { rankUndeclaredImpact, type ImpactRankingInput } from './impactRanking';
self.onmessage = (event: MessageEvent<ImpactRankingInput>) => {
  try { self.postMessage({ result: rankUndeclaredImpact(event.data) }); }
  catch (cause) { self.postMessage({ error: cause instanceof Error ? cause.message : '수정 후보 검색 실패' }); }
};
