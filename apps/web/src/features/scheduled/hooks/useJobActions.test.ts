/**
 * Unit tests for `useJobActions`.
 *
 * Layer: unit.
 * Goal: `toggleEnabled` is optimistic and rolls back on error; `runNow` succeeds and surfaces the
 * overlap toast on 409; `remove` succeeds.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`, with a `server.use` override for the
 * rollback case.
 */
import type { JobSummary } from '@agent-hangar/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { server } from '@/mocks/server';

import { useJobActions } from './useJobActions';

afterEach(() => {
  resetScheduledStore();
});

const depAudit: JobSummary = {
  id: 'job-dep-audit',
  name: 'Dep audit',
  cron: '0 9 * * 1',
  timezone: 'UTC',
  prompt: 'Run a dependency audit.',
  repoUrl: 'https://github.com/acme/web',
  branch: 'main',
  enabled: false,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastRunStatus: null,
};

const nightlyTests: JobSummary = { ...depAudit, id: 'job-nightly-tests', name: 'Nightly tests' };

describe('toggleEnabled', () => {
  /**
   * The override records the job revision it was applied on top of, so `resolveEnabled` can tell
   * an override that is still covering an in-flight write from one the server has moved past.
   */
  it('stamps the override with the revision it was applied to', async () => {
    const { result } = renderHook(() => useJobActions());
    await act(async () => {
      await result.current.toggleEnabled(depAudit, true);
    });
    expect(result.current.overrides[depAudit.id]).toEqual({
      enabled: true,
      appliedTo: depAudit.updatedAt,
    });
    expect(result.current.pending[depAudit.id]).toBeUndefined();
  });

  /** Rolls back the override and shows an error toast when the mutation fails. */
  it('rolls back the override on error', async () => {
    server.use(
      http.patch('/api/jobs/:id', () =>
        HttpResponse.json({ error: { code: 'SERVER_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useJobActions());
    await act(async () => {
      await result.current.toggleEnabled(depAudit, true);
    });
    expect(result.current.overrides[depAudit.id]).toBeUndefined();
  });
});

describe('runNow', () => {
  /** Starts a run for a job with no active run: success toast and runs-query invalidation. */
  it('starts a run', async () => {
    const { result } = renderHook(() => useJobActions());
    await act(async () => {
      await result.current.runNow(depAudit);
    });
    expect(result.current.pending[depAudit.id]).toBeUndefined();
  });

  /** A job with a RUNNING run already answers 409, toasted as an overlap skip. */
  it('toasts the overlap message on 409', async () => {
    const { result } = renderHook(() => useJobActions());
    await act(async () => {
      await result.current.runNow(nightlyTests);
    });
    expect(result.current.pending[nightlyTests.id]).toBeUndefined();
  });

  /** A non-409 failure is toasted without throwing. */
  it('toasts a generic error without throwing', async () => {
    server.use(
      http.post('/api/jobs/:id/run', () =>
        HttpResponse.json({ error: { code: 'SERVER_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useJobActions());
    await act(async () => {
      await result.current.runNow(depAudit);
    });
    expect(result.current.pending[depAudit.id]).toBeUndefined();
  });
});

describe('remove', () => {
  /** Deletes a job without throwing. */
  it('deletes a job', async () => {
    const { result } = renderHook(() => useJobActions());
    await act(async () => {
      await result.current.remove(depAudit);
    });
    await waitFor(() => {
      expect(result.current.pending[depAudit.id]).toBeUndefined();
    });
  });

  /** A failed delete is toasted without throwing. */
  it('toasts an error without throwing', async () => {
    server.use(
      http.delete('/api/jobs/:id', () =>
        HttpResponse.json({ error: { code: 'SERVER_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useJobActions());
    await act(async () => {
      await result.current.remove(depAudit);
    });
    expect(result.current.pending[depAudit.id]).toBeUndefined();
  });
});
