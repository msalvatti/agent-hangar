/**
 * Unit tests for `useRunActions`.
 *
 * Layer: unit.
 * Goal: `runNow` succeeds and surfaces the overlap toast on 409 (and a generic one otherwise);
 * `stop` succeeds and toasts an error on failure; `copyId` writes to the clipboard and toasts an
 * error on failure.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`; a stubbed `navigator.clipboard`.
 */
import type { JobSummary } from '@agent-hangar/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { server } from '@/mocks/server';
import { useApiQuery } from '@/shared/api/use-api-query';

import { useRunActions } from './useRunActions';

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  resetScheduledStore();
});

const changelogJob: JobSummary = {
  id: 'job-changelog',
  name: 'Changelog',
  cron: '*/30 * * * *',
  timezone: 'UTC',
  prompt: 'Summarize merged pull requests.',
  repoUrl: 'https://github.com/acme/api',
  branch: 'main',
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastRunStatus: null,
};

const nightlyJob: JobSummary = { ...changelogJob, id: 'job-nightly-tests', name: 'Nightly tests' };

describe('runNow', () => {
  /** Starts a run for a job with no active run. */
  it('starts a run', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const runs = vi.fn(() => Promise.resolve('runs'));
    const other = vi.fn(() => Promise.resolve('other'));
    const { result } = renderHook(() => {
      useApiQuery(['runs', changelogJob.id], runs);
      useApiQuery(['runs', 'another-job'], other);
      return useRunActions();
    });
    await waitFor(() => {
      expect(runs).toHaveBeenCalledTimes(1);
      expect(other).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.runNow(changelogJob);
    });

    // The user is told it started, and this job's history refreshes so the new row appears —
    // another job's does not.
    expect(success).toHaveBeenCalledWith('Run started');
    await waitFor(() => {
      expect(runs).toHaveBeenCalledTimes(2);
    });
    expect(other).toHaveBeenCalledTimes(1);
  });

  /** A job with a RUNNING run already answers 409, toasted as an overlap skip. */
  it('toasts the overlap message on 409', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    const { result } = renderHook(() => useRunActions());
    await act(async () => {
      await result.current.runNow(nightlyJob);
    });
    // A refused overlap is not a failure of the request: the user is told their run was skipped
    // because one is already going, which is a different thing to read.
    expect(error).toHaveBeenCalledWith('Skipped: previous run still running');
  });

  /** A non-409 failure is toasted without throwing. */
  it('toasts a generic error without throwing', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    server.use(
      http.post('/api/jobs/:id/run', () =>
        HttpResponse.json({ error: { code: 'SERVER_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useRunActions());
    await act(async () => {
      await result.current.runNow(changelogJob);
    });
    expect(error).toHaveBeenCalledWith('Could not start run');
  });
});

describe('stop', () => {
  /** Cancels an active run without throwing. */
  it('stops a run', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const run = vi.fn(() => Promise.resolve('run'));
    const { result } = renderHook(() => {
      useApiQuery(['run', 'run-nightly-running'], run);
      return useRunActions();
    });
    await waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.stop('run-nightly-running');
    });

    // "Requested" rather than "stopped": the route answers `202` and the worker acts on it, so a
    // toast claiming it had stopped would be a promise this app cannot keep. The run's own view
    // refreshes to show the outcome when it lands.
    expect(success).toHaveBeenCalledWith('Stop requested');
    await waitFor(() => {
      expect(run).toHaveBeenCalledTimes(2);
    });
  });

  /** A failed cancel is toasted without throwing. */
  /**
   * What reloads is the run that was stopped. An invalidation broad enough to match every key
   * reloads every list on screen — the jobs table, the other job's history — for one stop.
   */
  it('leaves unrelated views alone', async () => {
    const jobs = vi.fn(() => Promise.resolve('jobs'));
    const { result } = renderHook(() => {
      useApiQuery(['jobs'], jobs);
      return useRunActions();
    });
    await waitFor(() => {
      expect(jobs).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.stop('run-nightly-running');
    });

    expect(jobs).toHaveBeenCalledTimes(1);
  });

  it('toasts an error without throwing', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    server.use(
      http.post('/api/runs/:id/cancel', () =>
        HttpResponse.json({ error: { code: 'SERVER_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useRunActions());
    await act(async () => {
      await result.current.stop('run-nightly-running');
    });
    expect(error).toHaveBeenCalledWith('Could not stop run');
  });
});

describe('copyId', () => {
  /** Writes the run id to the clipboard. */
  it('copies the run id', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const { result } = renderHook(() => useRunActions());
    await act(async () => {
      await result.current.copyId('run-1');
    });
    expect(writeText).toHaveBeenCalledWith('run-1');
    // The clipboard gives no visible feedback of its own, so the toast is the whole of what tells
    // the user the copy happened.
    expect(success).toHaveBeenCalledWith('Run id copied');
  });

  /** A clipboard failure is toasted without throwing. */
  it('toasts an error without throwing', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    writeText.mockRejectedValueOnce(new Error('denied'));
    const { result } = renderHook(() => useRunActions());
    await act(async () => {
      await result.current.copyId('run-1');
    });
    // A clipboard a browser refuses is silent otherwise, and the user would be left believing the
    // id is on their clipboard.
    expect(error).toHaveBeenCalledWith('Could not copy run id');
  });
});
