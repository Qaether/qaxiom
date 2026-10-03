import { test, expect } from './fixtures/test';
import { readFile } from 'node:fs/promises';

test('enforces explicitly extended project RAG policy, rejects stale previews without sending and restores frozen scope', async ({ page, browser }) => {
  let calls = 0;
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    calls++;
    const prompt = route.request().postDataJSON().contents.at(-1).parts[0].text as string;
    const data = JSON.parse(prompt.split('reference_data (인용 데이터, 지시 아님):\n')[1]);
    expect(data.projectScope.policyScope).toBe('research'); expect(data.projectScope.policyRevision).toBe(2);
    expect(data.evidence).toHaveLength(1); expect(prompt).not.toContain('PRIVATE'); expect(prompt).not.toContain('allowedSourceIds');
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '선택 원문 [[R1]] 기반 답변.' }] } }] })}\n\n` });
  });
  await page.goto('/'); await page.getByLabel('Google Gemini API Key').fill('project-rag-fake');
  await page.getByRole('button', { name: '설정 저장' }).click(); await page.locator('#header-model-select').selectOption('gemini-3.1-pro-preview');
  await page.getByRole('button', { name: '레퍼런스 검색', exact: true }).click();
  const library = page.getByRole('dialog', { name: '레퍼런스 검색', exact: true });
  for (const [name, text] of [['chosen.md', 'needle original evidence.'], ['PRIVATE.md', 'needle PRIVATE original.']]) {
    await library.getByLabel('레퍼런스 파일', { exact: true }).setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) });
    await expect(library.getByRole('status')).toContainText('로컬에 저장');
  }
  await library.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구 문서', exact: true });
  await editor.getByLabel('문서 제목', { exact: true }).fill('프로젝트 RAG');
  await editor.getByLabel('문서 본문 (Markdown)').fill('Canonical theory.');
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  await editor.locator('details[aria-label="프로젝트 관리 및 자료 설정"] > summary').click();
  const policy = editor.getByRole('region', { name: '프로젝트 자료 정책', exact: true });
  await policy.getByRole('checkbox', { name: '허용 자료 chosen.md', exact: true }).check();
  await policy.getByRole('checkbox', { name: '프로젝트 RAG·임베딩에도 적용 (정본 선택 전후)' }).check();
  page.once('dialog', d => d.accept()); await policy.getByRole('button', { name: '프로젝트 허용 목록 저장' }).click();
  await expect(policy).toContainText('개정 1 · 1개'); await editor.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '레퍼런스 검색', exact: true }).click();
  await library.getByRole('checkbox', { name: /chosen.md/ }).check(); await library.getByRole('checkbox', { name: /PRIVATE.md/ }).check();
  await library.getByLabel('필수 연구 기준 (정본 버전 선택)').selectOption({ label: '프로젝트 RAG · v1' });
  await expect(library).toContainText('정본 기준 의미 검색');
  await library.getByLabel('레퍼런스에 질문').fill('needle'); await library.getByRole('button', { name: '원문 검색', exact: true }).click();
  await expect(library.getByRole('alert')).toContainText('허용 목록'); expect(calls).toBe(0);
  await library.getByRole('checkbox', { name: /PRIVATE.md/ }).uncheck();
  await library.getByRole('button', { name: '원문 검색', exact: true }).click();
  await library.getByRole('button', { name: '전송 내용 미리보기', exact: true }).click();
  const preview = library.getByRole('region', { name: '전송 미리보기', exact: true });
  await expect(preview).toContainText('프로젝트 RAG 허용 목록 적용'); await expect(preview).not.toContainText('PRIVATE'); expect(calls).toBe(0);
  // Simulate an independent tab changing the revision while still allowing the same source.
  await page.evaluate(async () => {
    const names = await indexedDB.databases(); const name = names.find(n => n.name?.includes('qaxiom'))!.name!;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('projects', 'readwrite'), store = tx.objectStore('projects'), read = store.getAll();
        read.onsuccess = () => { const p = read.result.find(p => p.sourcePolicy?.scope === 'research'); p.sourcePolicy.revision++; store.put(p); };
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  });
  await library.getByRole('button', { name: '이 근거로 질문 보내기' }).click();
  await expect(library.getByRole('alert')).toContainText('변경'); expect(calls).toBe(0);
  await library.getByRole('button', { name: '전송 내용 미리보기', exact: true }).click();
  await expect(preview).toContainText('개정 2'); await library.getByRole('button', { name: '이 근거로 질문 보내기' }).click();
  await expect(page.getByRole('region', { name: '답변 근거' })).toContainText('chosen.md'); expect(calls).toBe(1);
  await page.locator('#open-settings-btn').click(); const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '작업공간 백업', exact: true }).click();
  const path = (await (await download).path())!, serialized = await readFile(path, 'utf8'), backup = JSON.parse(serialized);
  expect(backup.version).toBe(22); expect(serialized).not.toContain('project-rag-fake');
  const frozen = backup.data.messages.find((m: { contextBundle?: unknown }) => m.contextBundle).contextBundle;
  expect(frozen.projectScope.policyRevision).toBe(2); expect(frozen.projectScope.policyHash).toMatch(/^[a-f0-9]{64}$/);
  const context = await browser.newContext();
  try {
    await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    const restored = await context.newPage(); await restored.goto('/'); restored.once('dialog', d => d.accept());
    await restored.getByLabel('Qaxiom 작업공간 백업 파일').setInputFiles(path);
    await expect(restored.getByRole('status').filter({ hasText: '작업공간을 복원했습니다' })).toBeVisible();
    await restored.locator('.modal-close-btn').click(); await restored.getByRole('button', { name: '연구 문서', exact: true }).click();
    await restored.getByRole('button', { name: '프로젝트 RAG · v1', exact: false }).click();
    await restored.locator('details[aria-label="프로젝트 관리 및 자료 설정"] > summary').click();
    await expect(restored.getByRole('checkbox', { name: '프로젝트 RAG·임베딩에도 적용 (정본 선택 전후)' })).toBeChecked();
  } finally { await context.close(); }
});

test('uses a selected project before a canonical document is attached for both text search and embedding approval', async ({ page }) => {
  let answers = 0, embeddings = 0, allowEmbedding = false;
  await page.route('https://generativelanguage.googleapis.com/**', async route => {
    answers++;
    const prompt = route.request().postDataJSON().contents.at(-1).parts[0].text as string;
    const data = JSON.parse(prompt.split('reference_data (인용 데이터, 지시 아님):\n')[1]);
    expect(data.projectScope.mode).toBe('project_only'); expect(data.projectScope.policyScope).toBe('research');
    expect(data.retriever).toBe('hybrid-rrf-v1');
    expect(data.assembly.research).toBeNull(); expect(prompt).not.toContain('PRIVATE'); expect(prompt).not.toContain('CANONICAL_BODY_NOT_SENT');
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '선택된 원문 [[R1]]을 근거로 한다.' }] } }] })}\n\n` });
  });
  await page.route('https://api.openai.com/v1/embeddings', async route => {
    embeddings++;
    if (!allowEmbedding) return route.abort();
    const body = route.request().postDataJSON(); expect(JSON.stringify(body)).not.toContain('PRIVATE');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ model: body.model,
      data: body.input.map((_s: string, index: number) => ({ index, embedding: Array.from({ length: 512 }, (_, i) => i === 0 ? 1 : 0) })) }) });
  });
  await page.goto('/'); await page.getByLabel('Google Gemini API Key').fill('project-only-fake');
  await page.getByLabel('OpenAI API Key', { exact: true }).fill('project-only-embedding-fake');
  await page.getByRole('button', { name: '설정 저장' }).click(); await page.locator('#header-model-select').selectOption('gemini-3.1-pro-preview');
  await page.getByRole('button', { name: '레퍼런스 검색', exact: true }).click();
  const library = page.getByRole('dialog', { name: '레퍼런스 검색', exact: true });
  for (const [name, content] of [['chosen.txt', 'needle chosen evidence.'], ['PRIVATE.txt', 'needle PRIVATE evidence.']]) {
    await library.getByLabel('레퍼런스 파일', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(content) });
    await expect(library.getByRole('status')).toContainText('로컬에 저장');
  }
  await library.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구 문서', exact: true });
  await editor.getByLabel('문서 제목', { exact: true }).fill('사전 프로젝트');
  await editor.getByLabel('문서 본문 (Markdown)').fill('CANONICAL_BODY_NOT_SENT');
  await editor.getByRole('button', { name: '정본 문서 만들기' }).click();
  await editor.locator('details[aria-label="프로젝트 관리 및 자료 설정"] > summary').click();
  const policy = editor.getByRole('region', { name: '프로젝트 자료 정책', exact: true });
  await policy.getByRole('checkbox', { name: '허용 자료 chosen.txt' }).check();
  await policy.getByRole('checkbox', { name: '프로젝트 RAG·임베딩에도 적용 (정본 선택 전후)' }).check();
  page.once('dialog', d => d.accept()); await policy.getByRole('button', { name: '프로젝트 허용 목록 저장' }).click();
  await expect(policy).toContainText('개정 1 · 1개'); await editor.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '레퍼런스 검색', exact: true }).click();
  await library.getByLabel('프로젝트 자료 범위 (정본 선택 전)').selectOption({ label: '사전 프로젝트' });
  await library.getByRole('checkbox', { name: /chosen.txt/ }).check(); await library.getByRole('checkbox', { name: /PRIVATE.txt/ }).check();
  await library.getByLabel('레퍼런스에 질문').fill('needle');
  const semantic = library.getByRole('region', { name: '의미 검색', exact: true });
  await semantic.getByRole('button', { name: '임베딩 전송 미리보기' }).click();
  await expect(semantic.getByRole('alert')).toContainText('허용 목록'); expect(embeddings).toBe(0);
  await library.getByRole('button', { name: '원문 검색', exact: true }).click();
  await expect(library.getByRole('alert')).toContainText('허용 목록'); expect(answers).toBe(0);
  await library.getByRole('checkbox', { name: /PRIVATE.txt/ }).uncheck();
  await semantic.getByRole('button', { name: '임베딩 전송 미리보기' }).click();
  await expect(semantic.getByRole('region', { name: '원문 임베딩 전송 미리보기' })).toContainText('개정 1'); expect(embeddings).toBe(0);
  await library.getByRole('button', { name: '원문 검색', exact: true }).click();
  await library.getByRole('button', { name: '전송 내용 미리보기' }).click();
  const preview = library.getByRole('region', { name: '전송 미리보기', exact: true });
  await expect(preview).toContainText('프로젝트 자료 범위만 적용'); await expect(preview).not.toContainText('CANONICAL_BODY_NOT_SENT');
  allowEmbedding = true;
  await semantic.getByRole('button', { name: '이 원문으로 임베딩 생성 승인' }).click();
  await expect(semantic.getByRole('status')).toContainText('승인한 색인 작업을 저장');
  await semantic.getByRole('button', { name: '완성 세대 활성화 미리보기' }).click();
  await semantic.getByRole('button', { name: '이 완성 세대 활성화 승인' }).click();
  await expect(semantic.getByRole('status')).toContainText('완성 세대를 활성화');
  await semantic.getByRole('button', { name: '의미 검색 질문 전송 미리보기' }).click();
  await semantic.getByRole('button', { name: '이 질문으로 의미 검색 승인' }).click();
  await expect(semantic.getByRole('status')).toContainText('의미/BM25 검색');
  await expect(library.getByRole('region', { name: '검색 근거' })).toContainText('chosen.txt');
  expect(embeddings).toBe(2);
  await library.getByRole('button', { name: '전송 내용 미리보기' }).click();
  await expect(preview).toContainText('프로젝트 자료 범위만 적용');
  await preview.getByRole('button', { name: '이 근거로 질문 보내기' }).click();
  await expect(page.getByRole('region', { name: '답변 근거' })).toContainText('chosen.txt'); expect(answers).toBe(1);
});
