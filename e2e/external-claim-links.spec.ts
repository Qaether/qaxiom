import { test, expect } from './fixtures/test';
import { readFile } from 'node:fs/promises';

test('links two explicitly selected project claims without provider calls, keeps provenance in backup and marks policy changes stale', async ({ page, browser }) => {
  test.setTimeout(120000);
  await page.goto('/');
  await page.getByLabel('Google Gemini API Key').fill('cross-project-fake-key');
  await page.getByRole('button', { name: '설정 저장' }).click();
  const seeded = await page.evaluate(async () => {
    const [{ createTheory }, { importReference }, { prepareExternalReview, parseExternalResponse }, { reviewSkeleton },
      { prepareExternalClaimAcceptance, acceptExternalClaim }, { qaxiomDatabase }, { EMPTY_CONTRACT }] = await Promise.all([
      import('/src/services/theory/documents.ts'), import('/src/services/retrieval/references.ts'),
      import('/src/services/theory/externalReview.ts'), import('/src/services/theory/reviews.ts'),
      import('/src/services/theory/externalClaims.ts'), import('/src/services/database.ts'),
      import('/src/services/theory/types.ts')
    ]);
    const make = async (title: string) => {
      const snapshot = await createTheory({ title, markdown: `${title} positive.`, contract: { ...EMPTY_CONTRACT, assumptions: `${title} > 0` } });
      const quote = `Independent ${title} result.`;
      const source = (await importReference(`${title}.md`, quote, 'external')).source;
      const span = (await qaxiomDatabase.reference_spans.where('sourceId').equals(source.id).first())!;
      const prepared = await prepareExternalReview(snapshot, [{ blockId: snapshot.blocks[0].id, spanId: span.id,
        theoryConditions: `all ${title}`, referenceConditions: `measured ${title}` }]);
      const pairId = prepared.context.pairs[0].id;
      const parsed = parseExternalResponse(JSON.stringify({ checkedPairIds: [pairId], limitations: [], assessments: [{ pairId,
        label: 'different_scope', theoryQuote: `${title} positive.`, referenceQuote: quote, theoryConditions: `all ${title}`,
        referenceConditions: `measured ${title}`, explanation: '범위 차이', referenceClaim: { statement: `${title} result`,
          evidenceQuote: quote, kind: 'empirical', basis: 'author_statement', conditions: `measured ${title}` } }] }), prepared.context);
      const run = reviewSkeleton(snapshot, 'external-v1', [], 'mock');
      run.external = { context: prepared.context, checkedPairIds: parsed.checkedPairIds, assessments: parsed.assessments };
      await qaxiomDatabase.review_runs.add(run);
      const claim = await acceptExternalClaim(await prepareExternalClaimAcceptance(run.id, pairId));
      return { projectId: snapshot.document.projectId, sourceId: source.id, claimId: claim.id };
    };
    return { a: await make('A'), b: await make('B') };
  });
  await page.getByRole('button', { name: '연구 문서', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '연구 문서', exact: true });
  await editor.getByRole('button', { name: 'A · v1' }).click();
  const project = editor.getByRole('region', { name: '프로젝트 외부 주장 원장' });
  await editor.locator('details[aria-label="프로젝트 관리 및 자료 설정"] > summary').click();
  await expect(project).toContainText('현재 범위 1개');
  const links = project.getByRole('region', { name: '교차 프로젝트 외부 주장 연결' });
  await links.getByLabel('비교할 다른 프로젝트').selectOption(seeded.b.projectId);
  await links.getByRole('button', { name: '선택 프로젝트 주장 불러오기' }).click();
  await expect(links).toContainText('선택 프로젝트에서 불러온 현재 주장 1개');
  await links.getByRole('combobox', { name: '현재 프로젝트 주장', exact: true }).selectOption(seeded.a.claimId);
  const suggestions = links.getByRole('region', { name: '어휘 일치 주장 후보' });
  await expect(suggestions).toContainText('일치 용어 result');
  await suggestions.getByRole('button', { name: /후보 선택: B result/ }).click();
  await expect(links.getByRole('combobox', { name: '다른 프로젝트 주장', exact: true })).toHaveValue(seeded.b.claimId);
  await links.getByRole('combobox', { name: '관계 후보 종류' }).selectOption('different_scope_candidate');
  await links.getByLabel('현재 프로젝트 주장 적용 조건').fill('all A');
  await links.getByLabel('다른 프로젝트 주장 적용 조건').fill('measured B');
  await links.getByLabel('사용자 판단 사유').fill('양쪽 원문과 조건을 확인한 후보 연결');
  await links.getByRole('button', { name: '교차 프로젝트 관계 미리보기' }).click();
  const preview = links.getByRole('region', { name: '교차 프로젝트 관계 승인 미리보기' });
  await expect(preview).toContainText('Independent A result.'); await expect(preview).toContainText('Independent B result.');
  await preview.getByRole('button', { name: '원문 확인 1: A.md' }).click();
  await expect(page.getByRole('dialog', { name: '인용 원문: A.md' })).toContainText('Independent A result.');
  await page.getByRole('dialog', { name: '인용 원문: A.md' }).getByRole('button', { name: '닫기' }).click();
  await preview.getByRole('button', { name: '원문 확인 2: B.md' }).click();
  await expect(page.getByRole('dialog', { name: '인용 원문: B.md' })).toContainText('Independent B result.');
  await page.getByRole('dialog', { name: '인용 원문: B.md' }).getByRole('button', { name: '닫기' }).click();
  await preview.getByLabel('현재 프로젝트 원문·조건 확인').check();
  await preview.getByLabel('다른 프로젝트 원문·조건 확인').check();
  page.once('dialog', dialog => dialog.accept());
  await preview.getByRole('button', { name: '이 후보 관계를 별도 승인·저장' }).click();
  await expect(links.getByRole('article', { name: '교차 프로젝트 관계 기록' })).toContainText('A result / B result');
  await expect(links).toContainText('현재 범위 1개');
  await page.evaluate(async ({ projectId }) => {
    const { qaxiomDatabase } = await import('/src/services/database.ts');
    await qaxiomDatabase.projects.update(projectId, { sourcePolicy: { scope: 'external_review', revision: 1, allowedSourceIds: [] } });
  }, { projectId: seeded.b.projectId });
  await links.getByRole('button', { name: '교차 프로젝트 관계 새로고침' }).click();
  await expect(links.getByRole('article', { name: '교차 프로젝트 관계 기록' })).toContainText('stale');
  await editor.getByRole('button', { name: '닫기', exact: true }).click();
  await page.locator('#open-settings-btn').click();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '작업공간 백업', exact: true }).click();
  const path = (await (await download).path())!, backup = JSON.parse(await readFile(path, 'utf8'));
  expect(backup.version).toBe(22); expect(backup.data.externalClaimLinks).toHaveLength(1);
  const other = await browser.newContext();
  try {
    await other.route('**/*', async route => { const url = new URL(route.request().url()); expect(['localhost', '127.0.0.1']).toContain(url.hostname); await route.continue(); });
    const restored = await other.newPage(); await restored.goto('/'); restored.once('dialog', dialog => dialog.accept());
    await restored.getByLabel('Qaxiom 작업공간 백업 파일').setInputFiles(path);
    await expect(restored.getByRole('status').filter({ hasText: '작업공간을 복원했습니다' })).toBeVisible();
    await restored.locator('.modal-close-btn').click(); await restored.getByRole('button', { name: '연구 문서', exact: true }).click();
    const reopened = restored.getByRole('dialog', { name: '연구 문서', exact: true });
    await reopened.getByRole('button', { name: 'A · v1' }).click();
    await reopened.locator('details[aria-label="프로젝트 관리 및 자료 설정"] > summary').click();
    await expect(reopened.getByRole('region', { name: '교차 프로젝트 외부 주장 연결' })).toContainText('저장된 교차 프로젝트 관계 1개');
    await expect(reopened.getByRole('article', { name: '교차 프로젝트 관계 기록' })).toContainText('stale');
  } finally { await other.close(); }
});
