import { describe, expect, it } from 'vitest';
import { combineContractSuggestions, parseContractSuggestions, prepareContractSuggestionRequest, prepareContractSuggestionRequests } from './contractSuggestions';

describe('research criteria suggestions', () => {
  it('keeps only candidates grounded in the submitted title or body', () => {
    const title = '중력 모형', body = '# 가정\n\n질량은 양수다.\n\n적용 범위는 정지계다.';
    const result = parseContractSuggestions(JSON.stringify({ criteria: {
      assumptions: { text: '질량이 양수라고 가정한다.', quote: '질량은 양수다.' },
      scope: { text: '모든 좌표계', quote: '본문에 없는 문장' },
      purpose: { text: '중력 모형을 연구한다.', quote: '중력 모형' },
      definitions: null
    } }), title, body);
    expect(result).toEqual({ assumptions: { text: '질량이 양수라고 가정한다.', quote: '질량은 양수다.' },
      purpose: { text: '중력 모형을 연구한다.', quote: '중력 모형' } });
  });

  it('requires parseable output and refuses silent truncation of a long document', () => {
    expect(() => parseContractSuggestions('not json', '제목', '본문')).toThrow('읽지 못했습니다');
    expect(() => prepareContractSuggestionRequest('제목', 'x'.repeat(41000))).toThrow('40 KB');
  });

  it('splits a long Unicode document without omitting or duplicating text', () => {
    const body = `# 가정\n${'질량은 양수다. 🌍\n'.repeat(4500)}`;
    const requests = prepareContractSuggestionRequests('중력 모형', body);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.map(item => item.markdown).join('')).toBe(body.trim());
    for (const request of requests) {
      expect(new TextEncoder().encode(JSON.stringify({ title: '중력 모형', markdown: request.markdown })).length).toBeLessThanOrEqual(40000);
      expect(request.prompt).toContain(JSON.stringify({ title: '중력 모형', markdown: request.markdown }));
    }
  });

  it('keeps the first grounded suggestion for each field across chunks', () => {
    expect(combineContractSuggestions([
      { assumptions: { text: '첫 가정', quote: '첫 근거' } },
      { assumptions: { text: '둘째 가정', quote: '둘째 근거' }, scope: { text: '범위', quote: '범위 근거' } }
    ])).toEqual({ assumptions: { text: '첫 가정', quote: '첫 근거' }, scope: { text: '범위', quote: '범위 근거' } });
  });
});
