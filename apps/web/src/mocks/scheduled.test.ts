/**
 * Unit tests for the scheduled-jobs mock handlers.
 *
 * Layer: unit.
 * Goal: every route parses with its core Zod schema, sorting and validation match spec 03 §4, and
 * `POST /api/jobs/:id/run` enforces the overlap policy — a run requested while one is `RUNNING`
 * is recorded as a `FAILED` run and answers `409`.
 * Mocks: MSW node server serving this module's handlers.
 */
import {
  jobSummary,
  listJobsResponse,
  listRunsResponse,
  runDetail,
  triggerRunResponse,
} from '@agent-hangar/core';
import { afterEach, describe, expect, it } from 'vitest';

import { registerMockServer } from '@/mocks/vitest';
import { apiFetch, ApiClientError } from '@/shared/api/client';

import { resetScheduledStore } from './scheduled';

registerMockServer();

afterEach(() => {
  resetScheduledStore();
});

describe('GET /api/jobs', () => {
  /** The seeded jobs are returned sorted by name and each entry parses as a jobSummary. */
  it('returns the seeded jobs sorted by name', async () => {
    const result = await apiFetch('listJobs');
    expect(listJobsResponse.safeParse(result).success).toBe(true);
    expect(result.jobs.map((job) => job.name)).toEqual(['Changelog', 'Dep audit', 'Nightly tests']);
  });
});

describe('POST /api/jobs', () => {
  /** A valid body creates a job and returns 201 with a parseable jobSummary. */
  it('creates a job from a valid body', async () => {
    const created = await apiFetch('createJob', {
      body: {
        name: 'New job',
        cron: '0 0 * * *',
        timezone: 'UTC',
        prompt: 'Do the thing.',
        repoUrl: 'https://github.com/acme/api',
        branch: 'main',
        enabled: true,
      },
    });
    expect(jobSummary.safeParse(created).success).toBe(true);
    expect(created.name).toBe('New job');
    expect(created.lastRunAt).toBeNull();
    expect(created.lastRunStatus).toBeNull();
  });

  /**
   * A body that fails the shared schema (empty name) answers 400 VALIDATION. Sent with a raw
   * `fetch` so the request reaches the handler's own schema check instead of being rejected by
   * `apiFetch`'s identical client-side schema first.
   */
  it('rejects a body that fails the shared schema', async () => {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '',
        cron: '0 0 * * *',
        timezone: 'UTC',
        prompt: 'Do the thing.',
        repoUrl: 'https://github.com/acme/api',
        branch: 'main',
        enabled: true,
      }),
    });
    expect(response.status).toBe(400);
  });

  /** A cron expression with the wrong number of fields answers 400 INVALID_CRON. */
  it('rejects a cron expression with the wrong shape', async () => {
    await expect(
      apiFetch('createJob', {
        body: {
          name: 'Bad cron',
          cron: '0 0 * *',
          timezone: 'UTC',
          prompt: 'Do the thing.',
          repoUrl: 'https://github.com/acme/api',
          branch: 'main',
          enabled: true,
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CRON' });
  });
});

describe('PATCH /api/jobs/:id', () => {
  /** Toggling `enabled` on a known job updates and returns it. */
  it('toggles the enabled flag', async () => {
    const updated = await apiFetch('updateJob', {
      params: { id: 'job-dep-audit' },
      body: { enabled: true },
    });
    expect(updated.enabled).toBe(true);
  });

  /** An unknown job id answers 404. */
  it('answers 404 for an unknown job', async () => {
    await expect(
      apiFetch('updateJob', { params: { id: 'missing' }, body: { enabled: true } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  /** A valid new cron expression is accepted and stored. */
  it('accepts a valid cron update', async () => {
    const updated = await apiFetch('updateJob', {
      params: { id: 'job-dep-audit' },
      body: { cron: '0 10 * * 2' },
    });
    expect(updated.cron).toBe('0 10 * * 2');
  });

  /** A malformed cron expression on PATCH answers 400 INVALID_CRON. */
  it('rejects a malformed cron update', async () => {
    await expect(
      apiFetch('updateJob', { params: { id: 'job-dep-audit' }, body: { cron: 'nope' } }),
    ).rejects.toMatchObject({ code: 'INVALID_CRON' });
  });

  /**
   * A body that fails the shared schema (name too long) answers 400 VALIDATION. Sent with a raw
   * `fetch` so the request reaches the handler's own schema check instead of being rejected by
   * `apiFetch`'s identical client-side schema first.
   */
  it('rejects a patch body that fails the shared schema', async () => {
    const response = await fetch('/api/jobs/job-dep-audit', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(500) }),
    });
    expect(response.status).toBe(400);
  });
});

describe('DELETE /api/jobs/:id', () => {
  /** An unknown job id answers 404. */
  it('answers 404 for an unknown job', async () => {
    await expect(apiFetch('deleteJob', { params: { id: 'missing' } })).rejects.toMatchObject({
      status: 404,
    });
  });

  /** Deleting a job removes it and its runs; the response resolves to undefined (204). */
  it('deletes a job and cascades its runs', async () => {
    await expect(
      apiFetch('deleteJob', { params: { id: 'job-changelog' } }),
    ).resolves.toBeUndefined();
    const { jobs } = await apiFetch('listJobs');
    expect(jobs.find((job) => job.id === 'job-changelog')).toBeUndefined();
    const runsResult = await apiFetch('listRuns', { params: { id: 'job-changelog' } }).catch(
      (error: unknown) => error,
    );
    expect(runsResult).toBeInstanceOf(ApiClientError);
  });
});

describe('POST /api/jobs/:id/run', () => {
  /** An unknown job id answers 404. */
  it('answers 404 for an unknown job', async () => {
    await expect(apiFetch('triggerRun', { params: { id: 'missing' } })).rejects.toMatchObject({
      status: 404,
    });
  });

  /** Triggering a run on a job with no active run answers 201 with a runId. */
  it('starts a run when none is active', async () => {
    const result = await apiFetch('triggerRun', { params: { id: 'job-changelog' } });
    expect(triggerRunResponse.safeParse(result).success).toBe(true);
  });

  /** Triggering a run while one is RUNNING records a FAILED overlap run and answers 409. */
  it('records a FAILED run and answers 409 when a run is already active', async () => {
    await expect(
      apiFetch('triggerRun', { params: { id: 'job-nightly-tests' } }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'RUN_IN_PROGRESS',
    });
    const { runs } = await apiFetch('listRuns', { params: { id: 'job-nightly-tests' } });
    expect(runs[0]?.status).toBe('FAILED');
    expect(runs[0]?.error).toBe('previous run still running');
  });
});

describe('GET /api/jobs/:id/runs', () => {
  /** An unknown job id answers 404. */
  it('answers 404 for an unknown job', async () => {
    await expect(apiFetch('listRuns', { params: { id: 'missing' } })).rejects.toMatchObject({
      status: 404,
    });
  });

  /** Runs come back newest first and every entry parses as a runSummary. */
  it('returns runs newest first', async () => {
    const result = await apiFetch('listRuns', { params: { id: 'job-changelog' } });
    expect(listRunsResponse.safeParse(result).success).toBe(true);
    const queuedAtValues = result.runs.map((run) => Date.parse(run.queuedAt));
    expect(queuedAtValues).toEqual([...queuedAtValues].sort((a, b) => b - a));
  });
});

describe('GET /api/runs/:id', () => {
  /** A known run parses as a runDetail and carries its tool calls. */
  it('returns the run detail', async () => {
    const result = await apiFetch('getRun', { params: { id: 'run-nightly-success' } });
    expect(runDetail.safeParse(result).success).toBe(true);
    expect(result.toolCalls.length).toBeGreaterThan(0);
  });

  /** An unknown run id answers 404. */
  it('answers 404 for an unknown run', async () => {
    await expect(apiFetch('getRun', { params: { id: 'missing' } })).rejects.toMatchObject({
      status: 404,
    });
  });
});
