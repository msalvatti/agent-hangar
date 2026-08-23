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
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { server } from '@/mocks/server';
import { useApiQuery } from '@/shared/api/use-api-query';

import { resolveEnabled, useJobActions } from './useJobActions';

afterEach(() => {
  resetScheduledStore();
  vi.restoreAllMocks();
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

describe('resolveEnabled', () => {
  /**
   * An override stands in only for the revision it was applied on top of. Once the job comes back
   * with a newer one — from this toggle or from a save in the dialog — that revision is the truth,
   * so a switch the user flicked cannot go on showing its own answer over a later one.
   */
  it.each([
    ['no override at all', undefined, false],
    [
      'an override on the revision it was applied to',
      { enabled: true, appliedTo: '2026-01-01T00:00:00.000Z' },
      true,
    ],
    [
      'an override on an older revision',
      { enabled: true, appliedTo: '2025-12-31T00:00:00.000Z' },
      false,
    ],
  ])('renders %s as %s', (_case, override, expected) => {
    const overrides = override === undefined ? {} : { [depAudit.id]: override };

    expect(resolveEnabled(depAudit, overrides)).toBe(expected);
  });
});

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
    expect(result.current.pending).toStrictEqual({});
  });

  /**
   * The row is marked pending for the length of the write and for that row alone: the switch is
   * disabled while it is in flight, and a table that marked every row would freeze all of them.
   */
  it('marks only the toggled row pending while the write is in flight', async () => {
    let release = (): void => undefined;
    server.use(
      http.patch('/api/jobs/:id', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json({ ...depAudit, enabled: true });
      }),
    );
    const { result } = renderHook(() => useJobActions());

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.toggleEnabled(depAudit, true);
    });
    await waitFor(() => {
      expect(result.current.pending).toStrictEqual({ [depAudit.id]: true });
    });

    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.pending).toStrictEqual({});
  });

  /**
   * What reloads is the table and the row. An invalidation broad enough to match every key reloads
   * every screen the app has open because one switch was flicked.
   */
  it('leaves unrelated queries alone', async () => {
    const settings = vi.fn(() => Promise.resolve('settings'));
    const { result } = renderHook(() => {
      useApiQuery(['settings'], settings);
      return useJobActions();
    });
    await waitFor(() => {
      expect(settings).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.toggleEnabled(depAudit, true);
    });

    expect(settings).toHaveBeenCalledTimes(1);
  });

  /**
   * Clearing a row's pending mark clears that row's and no other. Two rows can be in flight at once
   * — the operator flicks one switch and presses Run on another — and a clear that emptied the map
   * would unlock a control whose request is still going.
   */
  it('clears the pending mark of the row that finished, and only that row', async () => {
    const held: (() => void)[] = [];
    server.use(
      http.patch('/api/jobs/:id', async ({ params }) => {
        if (params.id === nightlyTests.id) {
          await new Promise<void>((resolve) => held.push(resolve));
        }
        return HttpResponse.json({ ...depAudit, enabled: true });
      }),
    );
    const { result } = renderHook(() => useJobActions());

    let slow!: Promise<void>;
    let quick!: Promise<void>;
    act(() => {
      slow = result.current.toggleEnabled(nightlyTests, true);
      quick = result.current.toggleEnabled(depAudit, true);
    });
    await waitFor(() => {
      expect(result.current.pending).toStrictEqual({
        [nightlyTests.id]: true,
        [depAudit.id]: true,
      });
    });

    await act(async () => {
      await quick;
    });
    expect(result.current.pending).toStrictEqual({ [nightlyTests.id]: true });

    await act(async () => {
      for (const release of held) {
        release();
      }
      await slow;
    });
    expect(result.current.pending).toStrictEqual({});
  });

  /**
   * A successful toggle refreshes both the table and the row's own detail: the switch is
   * optimistic, and the next revision has to come from the server rather than from the guess.
   */
  it('refreshes the table and the job it toggled', async () => {
    const jobs = vi.fn(() => Promise.resolve('jobs'));
    const one = vi.fn(() => Promise.resolve('one'));
    const other = vi.fn(() => Promise.resolve('other'));
    const { result } = renderHook(() => {
      useApiQuery(['jobs'], jobs);
      useApiQuery(['job', depAudit.id], one);
      useApiQuery(['job', 'another-job'], other);
      return useJobActions();
    });
    await waitFor(() => {
      expect(jobs).toHaveBeenCalledTimes(1);
      expect(one).toHaveBeenCalledTimes(1);
      expect(other).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.toggleEnabled(depAudit, true);
    });

    await waitFor(() => {
      expect(jobs).toHaveBeenCalledTimes(2);
      expect(one).toHaveBeenCalledTimes(2);
    });
    // And nobody else's row: the detail of another job has not changed.
    expect(other).toHaveBeenCalledTimes(1);
  });

  /** Rolls back the override and shows an error toast when the mutation fails. */
  it('rolls back the override on error', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
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
    expect(result.current.overrides).toStrictEqual({});
    // And says why the switch went back, rather than flicking back on its own.
    expect(error).toHaveBeenCalledWith('Could not update job');
  });
});

describe('runNow', () => {
  /** Starts a run for a job with no active run: success toast and runs-query invalidation. */
  it('starts a run', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const runs = vi.fn(() => Promise.resolve('runs'));
    const { result } = renderHook(() => {
      useApiQuery(['runs', depAudit.id], runs);
      return useJobActions();
    });
    await waitFor(() => {
      expect(runs).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.runNow(depAudit);
    });

    expect(result.current.pending).toStrictEqual({});
    // The user is told it started — a manual run answers `202` and shows nothing else — and the
    // run history refreshes so the new row appears without a reload.
    expect(success).toHaveBeenCalledWith('Run started');
    await waitFor(() => {
      expect(runs).toHaveBeenCalledTimes(2);
    });
  });

  /** A job with a RUNNING run already answers 409, toasted as an overlap skip. */
  /**
   * The row is marked while its run is being started, so the button cannot be pressed twice — a
   * second press is a second run of a job whose whole point is that it runs once per schedule.
   */
  it('marks the row pending while the run is being started', async () => {
    const held: (() => void)[] = [];
    server.use(
      http.post('/api/jobs/:id/run', async () => {
        await new Promise<void>((resolve) => held.push(resolve));
        return HttpResponse.json({ runId: 'run-1' }, { status: 202 });
      }),
    );
    const { result } = renderHook(() => useJobActions());

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.runNow(depAudit);
    });
    await waitFor(() => {
      expect(result.current.pending).toStrictEqual({ [depAudit.id]: true });
    });

    await act(async () => {
      for (const release of held) {
        release();
      }
      await pending;
    });
    expect(result.current.pending).toStrictEqual({});
  });

  it('toasts the overlap message on 409', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    const { result } = renderHook(() => useJobActions());
    await act(async () => {
      await result.current.runNow(nightlyTests);
    });
    expect(result.current.pending).toStrictEqual({});
    // A refused overlap is not a failure of the request, and the wording says so: the user is
    // told their run was skipped because one is already going, not that something went wrong.
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
    const { result } = renderHook(() => useJobActions());
    await act(async () => {
      await result.current.runNow(depAudit);
    });
    expect(result.current.pending).toStrictEqual({});
    // Told apart from the overlap above: this one is a failure the user can retry.
    expect(error).toHaveBeenCalledWith('Could not start run');
  });
});

describe('remove', () => {
  /** Deletes a job without throwing. */
  it('deletes a job', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const jobs = vi.fn(() => Promise.resolve('jobs'));
    const { result } = renderHook(() => {
      useApiQuery(['jobs'], jobs);
      return useJobActions();
    });
    await waitFor(() => {
      expect(jobs).toHaveBeenCalledTimes(1);
    });

    let removed!: boolean;
    await act(async () => {
      removed = await result.current.remove(depAudit);
    });

    // The answer is what the caller closes its dialog on, so a delete that reported nothing would
    // leave the confirmation open over a job that is gone.
    expect(removed).toBe(true);
    expect(success).toHaveBeenCalledWith('Job deleted');
    await waitFor(() => {
      expect(jobs).toHaveBeenCalledTimes(2);
    });
    expect(result.current.pending).toStrictEqual({});
  });

  /** A failed delete is toasted without throwing. */
  /**
   * And while it is being deleted, for the same reason: the row is still on screen until the table
   * reloads, and a second press deletes a job that is already gone.
   */
  it('marks the row pending while the delete is in flight', async () => {
    const held: (() => void)[] = [];
    server.use(
      http.delete('/api/jobs/:id', async () => {
        await new Promise<void>((resolve) => held.push(resolve));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { result } = renderHook(() => useJobActions());

    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.remove(depAudit);
    });
    await waitFor(() => {
      expect(result.current.pending).toStrictEqual({ [depAudit.id]: true });
    });

    await act(async () => {
      for (const release of held) {
        release();
      }
      await pending;
    });
    expect(result.current.pending).toStrictEqual({});
  });

  it('toasts an error without throwing', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    server.use(
      http.delete('/api/jobs/:id', () =>
        HttpResponse.json({ error: { code: 'SERVER_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useJobActions());

    let removed!: boolean;
    await act(async () => {
      removed = await result.current.remove(depAudit);
    });

    // The caller keeps its dialog open on a `false`, which is the difference between "deleted" and
    // "we tried" — and the row is not pending any more either way.
    expect(removed).toBe(false);
    expect(error).toHaveBeenCalledWith('Could not delete job');
    expect(result.current.pending).toStrictEqual({});
  });
});
