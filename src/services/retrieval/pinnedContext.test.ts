// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { QaxiomDatabase } from '../database';
import { createTheory, updateVersionReferenceIds } from '../theory/documents';
import { EMPTY_CONTRACT } from '../theory/types';
import { importReference } from './references';
import { buildPinnedReferenceContextBundle } from './pinnedContext';

const dbs: QaxiomDatabase[] = [];

function createTestDb(name: string): QaxiomDatabase {
  const db = new QaxiomDatabase(name);
  dbs.push(db);
  return db;
}

describe('buildPinnedReferenceContextBundle', () => {
  afterEach(async () => {
    while (dbs.length) {
      await dbs.pop()!.delete();
    }
  });

  it('returns undefined when no references are pinned to the active note', async () => {
    const db = createTestDb(`pinned-empty-${Date.now()}`);
    const theory = await createTheory(
      { title: 'Note', markdown: 'Body', contract: EMPTY_CONTRACT },
      db
    );
    const bundle = await buildPinnedReferenceContextBundle({
      documentId: theory.document.id,
      query: 'What is in the paper?',
      db
    });
    expect(bundle).toBeUndefined();
  });

  it('builds a ContextBundle only from references pinned to the active research note', async () => {
    const db = createTestDb(`pinned-active-${Date.now()}`);
    const theory = await createTheory(
      { title: 'Note', markdown: 'Body', contract: EMPTY_CONTRACT },
      db
    );
    const { source: pinnedRef } = await importReference(
      'pinned-paper.md',
      'Noether theorem relates differentiable symmetries to conservation laws.',
      'external',
      db
    );
    const { source: unpinnedRef } = await importReference(
      'unpinned-paper.md',
      'Unselected confidential paper content.',
      'external',
      db
    );

    await updateVersionReferenceIds(theory.version.id, [pinnedRef.id], db);

    const bundle = await buildPinnedReferenceContextBundle({
      documentId: theory.document.id,
      query: 'Explain this paper',
      db
    });

    expect(bundle).toBeDefined();
    expect(bundle!.selectedSourceIds).toEqual([pinnedRef.id]);
    expect(bundle!.selectedSourceIds).not.toContain(unpinnedRef.id);
    expect(bundle!.evidence[0].name).toBe('pinned-paper.md');
    expect(bundle!.evidence[0].span.text).toContain('Noether theorem');
  });
});
