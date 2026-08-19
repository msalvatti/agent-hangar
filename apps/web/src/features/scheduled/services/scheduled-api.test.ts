/**
 * Unit tests for the scheduled-jobs service layer.
 *
 * Layer: unit.
 * Goal: every function calls the right route with the right shape and returns the unwrapped
 * payload the mock handlers produce.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { registerMockServer } from '@/mocks/vitest';

import {
  cancelRun,
  createJob,
  deleteJob,
  getRun,
  listJobs,
  listRuns,
  runJob,
  updateJob,
} from './scheduled-api';

registerMockServer();

afterEach(() => {
  resetScheduledStore();
});

describe('listJobs', () => {
  /** Returns the seeded jobs array. */
  it('returns the jobs array', async () => {
    const jobs = await listJobs();
    expect(jobs.length).toBe(3);
  });

  /** Forwards an abort signal to the underlying fetch. */
  it('honours an abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(listJobs(controller.signal)).rejects.toThrow();
  });
});

describe('createJob', () => {
  /** Posts the body and returns the created job. */
  it('creates a job', async () => {
    const job = await createJob({
      name: 'Weekly report',
      cron: '0 8 * * 1',
      timezone: 'UTC',
      prompt: 'Summarize the week.',
      repoUrl: 'https://github.com/acme/api',
      branch: 'main',
      enabled: true,
    });
    expect(job.name).toBe('Weekly report');
  });
});

describe('updateJob', () => {
  /** Patches a job and returns the updated job. */
  it('updates a job', async () => {
    const job = await updateJob('job-dep-audit', { enabled: true });
    expect(job.enabled).toBe(true);
  });
});

describe('deleteJob', () => {
  /** Deletes a job, resolving to nothing. */
  it('deletes a job', async () => {
    await expect(deleteJob('job-changelog')).resolves.toBeUndefined();
  });
});

describe('runJob', () => {
  /** Triggers a run and returns its id. */
  it('starts a run and returns its id', async () => {
    const runId = await runJob('job-changelog');
    expect(runId.length).toBeGreaterThan(0);
  });
});

describe('listRuns', () => {
  /** Lists the runs of a job. */
  it('returns the job runs', async () => {
    const runs = await listRuns('job-changelog');
    expect(runs.length).toBeGreaterThan(0);
  });

  /** Forwards an abort signal to the underlying fetch. */
  it('honours an abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(listRuns('job-changelog', controller.signal)).rejects.toThrow();
  });
});

describe('getRun', () => {
  /** Fetches a run's detail. */
  it('returns the run detail', async () => {
    const detail = await getRun('run-nightly-success');
    expect(detail.run.id).toBe('run-nightly-success');
  });

  /** Forwards an abort signal to the underlying fetch. */
  it('honours an abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getRun('run-nightly-success', controller.signal)).rejects.toThrow();
  });
});

describe('cancelRun', () => {
  /** Cancels a run without throwing. */
  it('cancels a run', async () => {
    await expect(cancelRun('run-nightly-running')).resolves.toBeUndefined();
  });
});
