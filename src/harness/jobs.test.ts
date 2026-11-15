// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { QaxiomDatabase } from '../services/database';
import {
  checkpointHarnessJob,
  completeHarnessJob,
  failHarnessJob,
  getResumableJobs,
  startHarnessJob
} from './jobs';

const dbs: QaxiomDatabase[] = [];

function createTestDb(name: string): QaxiomDatabase {
  const db = new QaxiomDatabase(name);
  dbs.push(db);
  return db;
}

describe('harness jobs', () => {
  afterEach(async () => {
    while (dbs.length) {
      await dbs.pop()!.delete();
    }
  });

  it('tracks start -> checkpoint -> complete lifecycle', async () => {
    const db = createTestDb(`jobs-ok-${Date.now()}`);
    await startHarnessJob(
      { id: 'job-1', type: 'document_analysis', totalSteps: 3, checkpoint: { documentId: 'd1' } },
      db
    );
    expect((await getResumableJobs('document_analysis', db)).map(j => j.id)).toEqual(['job-1']);

    await checkpointHarnessJob('job-1', 2, { documentId: 'd1', lastSection: 2 }, db);
    const mid = await db.jobs.get('job-1');
    expect(mid?.completedSteps).toBe(2);
    expect(mid?.checkpoint).toEqual({ documentId: 'd1', lastSection: 2 });

    await completeHarnessJob('job-1', db);
    const done = await db.jobs.get('job-1');
    expect(done?.status).toBe('complete');
    expect(done?.completedSteps).toBe(3);
    expect(await getResumableJobs('document_analysis', db)).toEqual([]);
  });

  it('records cancelled and failed jobs cleanly', async () => {
    const db = createTestDb(`jobs-fail-${Date.now()}`);
    await startHarnessJob({ id: 'job-cancel', type: 'document_analysis', totalSteps: 2 }, db);
    await failHarnessJob('job-cancel', 'Cancelled by user', true, db);
    expect((await db.jobs.get('job-cancel'))?.status).toBe('cancelled');

    await startHarnessJob({ id: 'job-err', type: 'document_analysis', totalSteps: 2 }, db);
    await failHarnessJob('job-err', 'Network error', false, db);
    expect((await db.jobs.get('job-err'))?.status).toBe('failed');
    expect((await db.jobs.get('job-err'))?.errorMessage).toBe('Network error');
  });
});
