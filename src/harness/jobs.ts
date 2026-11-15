import { qaxiomDatabase, type JobRecord, type QaxiomDatabase } from '../services/database';
import { sanitizeEventPayload } from './sessionEvents';

export async function startHarnessJob(
  params: {
    id: string;
    type: string;
    totalSteps?: number;
    checkpoint?: Record<string, unknown>;
  },
  database: QaxiomDatabase = qaxiomDatabase
): Promise<JobRecord> {
  const now = Date.now();
  const record: JobRecord = {
    id: params.id,
    type: params.type,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    totalSteps: params.totalSteps,
    completedSteps: 0,
    checkpoint: params.checkpoint ? sanitizeEventPayload(params.checkpoint) : undefined
  };
  await database.jobs.put(record);
  return record;
}

export async function checkpointHarnessJob(
  jobId: string,
  completedSteps: number,
  checkpoint?: Record<string, unknown>,
  database: QaxiomDatabase = qaxiomDatabase
): Promise<void> {
  const existing = await database.jobs.get(jobId);
  if (!existing) return;
  await database.jobs.put({
    ...existing,
    completedSteps,
    updatedAt: Date.now(),
    checkpoint: checkpoint ? sanitizeEventPayload(checkpoint) : existing.checkpoint
  });
}

export async function completeHarnessJob(
  jobId: string,
  database: QaxiomDatabase = qaxiomDatabase
): Promise<void> {
  const existing = await database.jobs.get(jobId);
  if (!existing) return;
  await database.jobs.put({
    ...existing,
    status: 'complete',
    completedSteps: existing.totalSteps ?? existing.completedSteps,
    updatedAt: Date.now()
  });
}

export async function failHarnessJob(
  jobId: string,
  errorMessage: string,
  cancelled = false,
  database: QaxiomDatabase = qaxiomDatabase
): Promise<void> {
  const existing = await database.jobs.get(jobId);
  if (!existing) return;
  await database.jobs.put({
    ...existing,
    status: cancelled ? 'cancelled' : 'failed',
    errorMessage,
    updatedAt: Date.now()
  });
}

export async function getResumableJobs(
  type?: string,
  database: QaxiomDatabase = qaxiomDatabase
): Promise<JobRecord[]> {
  const all = await database.jobs.toArray();
  return all.filter(
    job => (job.status === 'running' || job.status === 'pending') && (!type || job.type === type)
  );
}
