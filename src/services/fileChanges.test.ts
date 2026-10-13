import { describe, expect, it } from 'vitest';
import { parseMessageFileChanges } from './fileChanges';

describe('fileChanges parser', () => {
  it('parses ```file_changes:document.md ... ``` block and extracts displayText', () => {
    const rawMessage = `
깨진 LaTeX 수식을 다음과 같이 정상적인 형태로 완성했습니다.

\`\`\`file_changes:document.md
# 양자역학 기초

슈뢰딩거 방정식:
$$i\\hbar\\frac{\\partial}{\\partial t}\\Psi = \\hat{H}\\Psi$$
\`\`\`

가운데 창에서 변경 사항을 검토해 주세요.
    `.trim();

    const result = parseMessageFileChanges(rawMessage, 'document.md');
    expect(result.fileChanges).toHaveLength(1);
    expect(result.fileChanges[0].filename).toBe('document.md');
    expect(result.fileChanges[0].proposedContent).toContain('$$i\\hbar\\frac{\\partial}{\\partial t}\\Psi = \\hat{H}\\Psi$$');

    // displayText should not contain the file content
    expect(result.displayText).toContain('깨진 LaTeX 수식을 다음과 같이 정상적인 형태로 완성했습니다.');
    expect(result.displayText).toContain('가운데 창에서 변경 사항을 검토해 주세요.');
    expect(result.displayText).not.toContain('$$i\\hbar');
  });

  it('handles regular messages without file changes', () => {
    const rawMessage = '안녕하세요! 오늘 어떤 연구를 진행하시나요?';
    const result = parseMessageFileChanges(rawMessage);
    expect(result.fileChanges).toHaveLength(0);
    expect(result.displayText).toBe(rawMessage);
  });

  it('fallback parses markdown code blocks when long document is provided', () => {
    const rawMessage = `
수정된 내용입니다.

\`\`\`markdown
# 제목
수정된 내용이 여기에 있습니다. 최소 50자 이상의 충분한 길이의 본문입니다.
\`\`\`
    `.trim();

    const result = parseMessageFileChanges(rawMessage, 'research.md');
    expect(result.fileChanges).toHaveLength(1);
    expect(result.fileChanges[0].filename).toBe('research.md');
    expect(result.displayText).toBe('수정된 내용입니다.');
  });

  it('uses default fallback text when stripped displayText is empty or short trailing chars like a single dot', () => {
    const rawMessage = `
\`\`\`file_changes:document.md
# Test content
$$E = mc^2$$
\`\`\`
.
    `.trim();

    const result = parseMessageFileChanges(rawMessage);
    expect(result.fileChanges).toHaveLength(1);
    expect(result.displayText).toBe('연구노트 본문의 수정 제안이 준비되었습니다.');
  });

  it('handles unclosed streaming file_changes block gracefully', () => {
    const streamingMessage = `
수정 중입니다.
\`\`\`file_changes:document.md
# Test in progress
    `.trim();

    const result = parseMessageFileChanges(streamingMessage);
    expect(result.fileChanges).toHaveLength(1);
    expect(result.displayText).toBe('수정 중입니다.');
    expect(result.fileChanges[0].proposedContent).toContain('# Test in progress');
  });
});
