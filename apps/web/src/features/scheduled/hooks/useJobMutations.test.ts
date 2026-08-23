/**
 * Unit tests for `useJobMutations`.
 *
 * Layer: unit.
 * Goal: `save` creates without a `jobId`, updates with one, surfaces the server's error message
 * and returns `null` on failure, and clears the error on demand.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`, with a `server.use` override for the
 * failure case.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { server } from '@/mocks/server';
import { useApiQuery } from '@/shared/api/use-api-query';

import type { JobFormValues } from '../lib/job-form';

import { useJobMutations } from './useJobMutations';

afterEach(() => {
  resetScheduledStore();
  vi.restoreAllMocks();
});

/**
 * Mounts the hook alongside the two listings a save is expected to refresh, so what each one is
 * asked to reload — and what it is not — is observable.
 *
 * @param jobId - Id of the job whose own view is mounted next to the listing.
 * @returns The hook's result plus a loader-call count per listing.
 */
function renderWithListings(jobId: string): {
  result: { current: ReturnType<typeof useJobMutations> };
  jobs: () => number;
  one: () => number;
} {
  const jobsLoader = vi.fn(() => Promise.resolve('jobs'));
  const oneLoader = vi.fn(() => Promise.resolve('one'));
  const { result } = renderHook(() => {
    useApiQuery(['jobs'], jobsLoader);
    useApiQuery(['job', jobId], oneLoader);
    return useJobMutations();
  });
  return {
    result,
    jobs: () => jobsLoader.mock.calls.length,
    one: () => oneLoader.mock.calls.length,
  };
}

const validValues: JobFormValues = {
  name: 'Weekly report',
  repoUrl: 'https://github.com/acme/api',
  branch: 'main',
  cron: '0 8 * * 1',
  timezone: 'UTC',
  prompt: 'Summarize the week.',
  enabled: true,
};

describe('useJobMutations', () => {
  /** Saving with no jobId creates a job and returns it. */
  it('creates a job', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const { result, jobs, one } = renderWithListings('job-dep-audit');
    await waitFor(() => {
      expect(jobs()).toBe(1);
      expect(one()).toBe(1);
    });

    let saved;
    await act(async () => {
      saved = await result.current.save(validValues);
    });

    expect(saved).toMatchObject({ name: 'Weekly report' });
    expect(result.current.error).toBeNull();
    expect(success).toHaveBeenCalledWith('Job saved');
    // The listing reloads so the new row appears. No single job's view is touched: there is no
    // job this save is about yet, and refreshing an unrelated one spends a request on nothing.
    await waitFor(() => {
      expect(jobs()).toBe(2);
    });
    expect(one()).toBe(1);
  });

  /**
   * `busy` is what disables the dialog's save button, so it has to be true for as long as the
   * request is in flight and false again afterwards — in both directions. Stuck on, the dialog
   * can never be saved again; never on, a second click sends a second create.
   */
  it('reports itself busy only while the request is in flight', async () => {
    const held: (() => void)[] = [];
    server.use(
      http.post('/api/jobs', async () => {
        await new Promise<void>((resolve) => held.push(resolve));
        // Falls through to the real mock handler, so the save that finishes is the one the app
        // performs — a hand-written body would take the failing path instead.
        return undefined;
      }),
    );
    const { result } = renderHook(() => useJobMutations());
    expect(result.current.busy).toBe(false);

    let pending: Promise<unknown> = Promise.resolve(null);
    act(() => {
      pending = result.current.save(validValues);
    });
    await waitFor(() => {
      expect(result.current.busy).toBe(true);
    });

    await act(async () => {
      for (const release of held) {
        release();
      }
      await pending;
    });
    expect(result.current.busy).toBe(false);
    // And the save succeeded, so it is the success path that cleared the flag.
    expect(await pending).toMatchObject({ name: 'Weekly report' });
  });

  /**
   * And it is cleared on the failing path too — the one that returns early.
   */
  it('stops reporting itself busy after a failure', async () => {
    server.use(
      http.post('/api/jobs', () =>
        HttpResponse.json({ error: { code: 'SERVER_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useJobMutations());
    await act(async () => {
      await result.current.save(validValues);
    });
    expect(result.current.busy).toBe(false);
  });

  /**
   * A retry starts from a clean slate: the message from the attempt before is dropped when the
   * next one begins, rather than sitting under a field the user has just corrected.
   */
  it('clears a previous error when a save is retried', async () => {
    server.use(
      http.post('/api/jobs', () =>
        HttpResponse.json({ error: { code: 'SERVER_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useJobMutations());
    await act(async () => {
      await result.current.save(validValues);
    });
    expect(result.current.error).toBe('boom');

    server.resetHandlers();
    await act(async () => {
      await result.current.save(validValues);
    });
    expect(result.current.error).toBeNull();
  });

  /** Saving with a jobId updates that job and returns it. */
  it('updates a job', async () => {
    const { result, jobs, one } = renderWithListings('job-dep-audit');
    await waitFor(() => {
      expect(jobs()).toBe(1);
      expect(one()).toBe(1);
    });

    let saved;
    await act(async () => {
      saved = await result.current.save({ ...validValues, name: 'Renamed' }, 'job-dep-audit');
    });

    expect(saved).toMatchObject({ id: 'job-dep-audit', name: 'Renamed' });
    // Both the listing and the job's own view are stale now, and the dialog is usually open over
    // the second of the two.
    await waitFor(() => {
      expect(jobs()).toBe(2);
      expect(one()).toBe(2);
    });
  });

  /**
   * The refreshed view is the job that was saved, not whichever job happens to be open elsewhere.
   */
  it('leaves another job untouched', async () => {
    const { result, one } = renderWithListings('job-nightly-tests');
    await waitFor(() => {
      expect(one()).toBe(1);
    });

    await act(async () => {
      await result.current.save({ ...validValues, name: 'Renamed' }, 'job-dep-audit');
    });

    expect(one()).toBe(1);
  });

  /** A server error surfaces its message and the save resolves to null. */
  it('surfaces a server error', async () => {
    server.use(
      http.post('/api/jobs', () =>
        HttpResponse.json({ error: { code: 'SERVER_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useJobMutations());
    let saved;
    await act(async () => {
      saved = await result.current.save(validValues);
    });
    expect(saved).toBeNull();
    expect(result.current.error).toBe('boom');
  });

  /** A network-level failure (not an `ApiClientError`) falls back to a generic message. */
  it('falls back to a generic message for a non-ApiClientError failure', async () => {
    server.use(http.post('/api/jobs', () => HttpResponse.error()));
    const { result } = renderHook(() => useJobMutations());
    let saved;
    await act(async () => {
      saved = await result.current.save(validValues);
    });
    expect(saved).toBeNull();
    expect(result.current.error).toBe('Could not save job');
  });

  /** clearError resets the error to null. */
  it('clears the error', async () => {
    server.use(
      http.post('/api/jobs', () =>
        HttpResponse.json({ error: { code: 'SERVER_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useJobMutations());
    await act(async () => {
      await result.current.save(validValues);
    });
    expect(result.current.error).toBe('boom');
    act(() => {
      result.current.clearError();
    });
    expect(result.current.error).toBeNull();
  });
});
