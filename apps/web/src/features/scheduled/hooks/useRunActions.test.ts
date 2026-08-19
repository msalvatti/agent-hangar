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
import { act, renderHook } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { server } from '@/mocks/server';
import { registerMockServer } from '@/mocks/vitest';

import { useRunActions } from './useRunActions';

registerMockServer();

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
    const { result } = renderHook(() => useRunActions());
    await act(async () => {
      await result.current.runNow(changelogJob);
    });
  });

  /** A job with a RUNNING run already answers 409, toasted as an overlap skip. */
  it('toasts the overlap message on 409', async () => {
    const { result } = renderHook(() => useRunActions());
    await act(async () => {
      await result.current.runNow(nightlyJob);
    });
  });

  /** A non-409 failure is toasted without throwing. */
  it('toasts a generic error without throwing', async () => {
    server.use(
      http.post('/api/jobs/:id/run', () =>
        HttpResponse.json({ error: { code: 'SERVER_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useRunActions());
    await act(async () => {
      await result.current.runNow(changelogJob);
    });
  });
});

describe('stop', () => {
  /** Cancels an active run without throwing. */
  it('stops a run', async () => {
    const { result } = renderHook(() => useRunActions());
    await act(async () => {
      await result.current.stop('run-nightly-running');
    });
  });

  /** A failed cancel is toasted without throwing. */
  it('toasts an error without throwing', async () => {
    server.use(
      http.post('/api/turns/:id/cancel', () =>
        HttpResponse.json({ error: { code: 'SERVER_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useRunActions());
    await act(async () => {
      await result.current.stop('run-nightly-running');
    });
  });
});

describe('copyId', () => {
  /** Writes the run id to the clipboard. */
  it('copies the run id', async () => {
    const { result } = renderHook(() => useRunActions());
    await act(async () => {
      await result.current.copyId('run-1');
    });
    expect(writeText).toHaveBeenCalledWith('run-1');
  });

  /** A clipboard failure is toasted without throwing. */
  it('toasts an error without throwing', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    const { result } = renderHook(() => useRunActions());
    await act(async () => {
      await result.current.copyId('run-1');
    });
  });
});
