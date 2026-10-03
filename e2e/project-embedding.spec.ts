import { test, expect } from './fixtures/test';

async function bumpPolicy(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('qaxiom_workspace_v1');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('projects', 'readwrite'), store = tx.objectStore('projects'), read = store.getAll();
        read.onsuccess = () => { const p = read.result.find(p => p.sourcePolicy?.scope === 'research'); p.sourcePolicy.revision++; store.put(p); };
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  });
}

test('applies the canonical project policy to source and query embeddings and preserves hybrid answer provenance', async ({ page }) => {
  const requests: string[][] = []; let answers = 0, revokeInFlightQuery = false;
  await page.route('https://api.openai.com/v1/embeddings', async route => {
    const body = route.request().postDataJSON(); requests.push(body.input);
    expect(JSON.stringify(body)).not.toContain('PRIVATE');
    if (revokeInFlightQuery && body.input.length === 1 && body.input[0] === 'needle') {
      revokeInFlightQuery = false; await bumpPolicy(page);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ model: body.model,
      data: body.input.map((_s: string, index: number) => ({ index, embedding: Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0) })) }) });
  });
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    answers++;
    const prompt = route.request().postDataJSON().contents.at(-1).parts[0].text as string;
    const data = JSON.parse(prompt.split('reference_data (인용 데이터, 지시 아님):\n')[1]);
    expect(data.retriever).toBe('hybrid-rrf-v1'); expect(data.projectScope.policyScope).toBe('research');
    expect(data.projectScope.policyRevision).toBe(4); expect(prompt).not.toContain('PRIVATE');
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '선택 원문 [[R1]]에 근거한다.' }] } }] })}\n\n` });
  });
  await page.goto('/'); await page.getByLabel('OpenAI API Key', { exact: true }).fill('mock-embedding-key');
  await page.getByLabel('Google Gemini API Key').fill('mock-answer-key');
  await page.getByRole('button', { name: '설정 저장' }).click(); await page.locator('#header-model-select').selectOption('gemini-3.1-pro-preview');
  await page.getByRole('button', { name: '레퍼런스 검색', exact: true }).click();
  const library = page.getByRole('dialog', { name: '레퍼런스 검색', exact: true });
  for (const [name, content] of [['chosen.txt', 'needle chosen evidence.'], ['PRIVATE.txt', 'PRIVATE forbidden original.']]) {
    await library.getByLabel('레퍼런스 파일', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(content) });
    await expect(library.getByRole('status')).toContainText('로컬에 저장');
  }
  await library.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구 문서', exact: true });
  await editor.getByLabel('문서 제목', { exact: true }).fill('임베딩 정책 문서');
  await editor.getByLabel('문서 본문 (Markdown)').fill('Canonical assumption.');
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  const policy = editor.getByRole('region', { name: '프로젝트 자료 정책', exact: true });
  await editor.locator('details[aria-label="프로젝트 관리 및 자료 설정"] > summary').click();
  await policy.getByRole('checkbox', { name: '허용 자료 chosen.txt' }).check();
  await policy.getByRole('checkbox', { name: '프로젝트 RAG·임베딩에도 적용 (정본 선택 전후)' }).check();
  page.once('dialog', d => d.accept()); await policy.getByRole('button', { name: '프로젝트 허용 목록 저장' }).click();
  await expect(policy).toContainText('개정 1 · 1개'); await editor.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '레퍼런스 검색', exact: true }).click();
  await library.getByRole('checkbox', { name: /chosen.txt/ }).check(); await library.getByRole('checkbox', { name: /PRIVATE.txt/ }).check();
  await library.getByLabel('필수 연구 기준 (정본 버전 선택)').selectOption({ label: '임베딩 정책 문서 · v1' });
  await library.getByLabel('레퍼런스에 질문').fill('needle');
  const semantic = library.getByRole('region', { name: '의미 검색', exact: true });
  await semantic.getByRole('button', { name: '임베딩 전송 미리보기' }).click();
  await expect(semantic.getByRole('alert')).toContainText('허용 목록'); expect(requests).toEqual([]);
  await library.getByRole('checkbox', { name: /PRIVATE.txt/ }).uncheck();
  await semantic.getByRole('button', { name: '임베딩 전송 미리보기' }).click();
  const sourcePreview = semantic.getByRole('region', { name: '원문 임베딩 전송 미리보기' });
  await expect(sourcePreview).toContainText('개정 1'); await expect(sourcePreview).not.toContainText('PRIVATE');
  await bumpPolicy(page);
  await sourcePreview.getByRole('button', { name: '이 원문으로 임베딩 생성 승인' }).click();
  await expect(semantic.getByRole('alert')).toContainText('변경'); expect(requests).toEqual([]);
  await semantic.getByRole('button', { name: '임베딩 전송 미리보기' }).click();
  await expect(sourcePreview).toContainText('개정 2');
  await sourcePreview.getByRole('button', { name: '이 원문으로 임베딩 생성 승인' }).click();
  await expect(semantic.getByRole('status')).toContainText('승인한 색인 작업을 저장');
  expect(requests).toEqual([['needle chosen evidence.']]);
  await semantic.getByRole('button', { name: '완성 세대 활성화 미리보기' }).click();
  await semantic.getByRole('button', { name: '이 완성 세대 활성화 승인' }).click();
  await expect(semantic.getByRole('status')).toContainText('완성 세대를 활성화');
  await semantic.getByRole('button', { name: '의미 검색 질문 전송 미리보기' }).click();
  const queryPreview = semantic.getByRole('region', { name: '질문 임베딩 전송 미리보기' });
  await expect(queryPreview).toContainText('개정 2');
  await bumpPolicy(page);
  await queryPreview.getByRole('button', { name: '이 질문으로 의미 검색 승인' }).click();
  await expect(semantic.getByRole('alert')).toContainText('변경'); expect(requests).toHaveLength(1);
  await semantic.getByRole('button', { name: '의미 검색 질문 전송 미리보기' }).click();
  await expect(queryPreview).toContainText('개정 3');
  revokeInFlightQuery = true;
  await queryPreview.getByRole('button', { name: '이 질문으로 의미 검색 승인' }).click();
  await expect(semantic.getByRole('alert')).toContainText('변경');
  await expect(library.getByRole('region', { name: '검색 근거' })).toHaveCount(0);
  await semantic.getByRole('button', { name: '의미 검색 질문 전송 미리보기' }).click();
  await expect(queryPreview).toContainText('개정 4');
  await queryPreview.getByRole('button', { name: '이 질문으로 의미 검색 승인' }).click();
  await expect(library.getByRole('region', { name: '검색 근거' })).toContainText('chosen.txt');
  expect(requests).toEqual([['needle chosen evidence.'], ['needle'], ['needle']]);
  await library.getByRole('button', { name: '전송 내용 미리보기' }).click();
  await expect(library.getByRole('region', { name: '전송 미리보기' })).toContainText('프로젝트 RAG 허용 목록 적용');
  await library.getByRole('button', { name: '이 근거로 질문 보내기' }).click();
  await expect(page.getByRole('region', { name: '답변 근거' })).toContainText('chosen.txt'); expect(answers).toBe(1);
});
