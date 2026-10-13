/**
 * Google Antigravity 스타일의 'Files with changes' 블록 파서 및 유틸리티
 */

export interface FileChangeItem {
  id: string;
  filename: string;
  proposedContent: string;
}

export interface ParsedMessageContent {
  displayText: string;
  fileChanges: FileChangeItem[];
}

/**
 * AI 응답 텍스트에서 ```file_changes:<filename> ... ``` 블록을 파싱하여
 * 대화창 표시용 텍스트(displayText)와 파일 변경 목록(fileChanges)으로 분리합니다.
 */
export function parseMessageFileChanges(
  content: string,
  defaultFilename: string = 'document.md'
): ParsedMessageContent {
  if (!content || typeof content !== 'string') {
    return { displayText: '', fileChanges: [] };
  }

  const fileChanges: FileChangeItem[] = [];

  // 1. ```file_changes:<filename> ... ``` 블록 파싱
  const fileChangeRegex = /```file_changes(?::([^\r\n]+))?\r?\n([\s\S]*?)\r?\n```/g;
  let hasSpecialBlock = false;

  const strippedText = content.replace(fileChangeRegex, (_match, rawFilename, fileBody) => {
    hasSpecialBlock = true;
    const filename = (rawFilename?.trim()) || defaultFilename;
    const proposedContent = fileBody?.trim() || '';
    if (proposedContent) {
      fileChanges.push({
        id: `change-${fileChanges.length + 1}`,
        filename,
        proposedContent,
      });
    }
    return ''; // displayText에서 해당 블록 제거
  });

  if (hasSpecialBlock) {
    const clean = strippedText.trim();
    // 3자 이하 자투리 글자(예: '.', '다.') 방지 및 의미 있는 요약문 유지
    const displayText = clean.length > 3 ? clean : '연구노트 본문의 수정 제안이 준비되었습니다.';
    return {
      displayText,
      fileChanges,
    };
  }

  // 2. 스트리밍 중 아직 닫히지 않은 ```file_changes 블록 처리
  const unclosedMatch = /```file_changes(?::([^\r\n]+))?(?:\r?\n([\s\S]*))?$/.exec(content);
  if (unclosedMatch) {
    const beforeBlock = content.slice(0, unclosedMatch.index).trim();
    const filename = unclosedMatch[1]?.trim() || defaultFilename;
    const streamingContent = unclosedMatch[2] || '';
    return {
      displayText: beforeBlock.length > 3 ? beforeBlock : '수정 제안을 생성하는 중입니다...',
      fileChanges: [{
        id: 'change-streaming',
        filename,
        proposedContent: streamingContent,
      }],
    };
  }

  // 3. 모델이 혹시 ```markdown filename=document.md 형태나 긴 markdown 코드블록으로 준 경우 보조 파싱
  const mdBlockRegex = /```(?:markdown|md)(?::([^\r\n]+))?\r?\n([\s\S]*?)\r?\n```/i;
  const mdMatch = mdBlockRegex.exec(content);
  if (mdMatch && mdMatch[2]?.trim().length >= 20) {
    // 본문 전체가 코드블록 하나인 경우 (또는 설명 + 코드블록)
    const proposedContent = mdMatch[2].trim();
    const filename = mdMatch[1]?.trim() || defaultFilename;
    const beforeBlock = content.slice(0, mdMatch.index).trim();
    const afterBlock = content.slice(mdMatch.index + mdMatch[0].length).trim();
    const rawDisplayText = [beforeBlock, afterBlock].filter(Boolean).join('\n\n').trim();
    const displayText = rawDisplayText.length > 3 ? rawDisplayText : '연구노트 본문의 수정 제안이 준비되었습니다.';

    fileChanges.push({
      id: 'change-1',
      filename,
      proposedContent,
    });

    return {
      displayText,
      fileChanges,
    };
  }

  return {
    displayText: content,
    fileChanges: [],
  };
}
