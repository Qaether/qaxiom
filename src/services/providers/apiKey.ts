export function validateApiKeyFormat(apiKey: string, providerLabel: string): string {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error(`${providerLabel} API 키가 설정되지 않았습니다.`);
  }
  if (/[^\x21-\x7E]/.test(trimmed)) {
    throw new Error(
      `${providerLabel} API 키에 사용할 수 없는 문자(공백, 한글 또는 비-ASCII 문자)가 포함되어 있습니다. 설정에서 API 키를 다시 확인해 주세요.`
    );
  }
  return trimmed;
}
