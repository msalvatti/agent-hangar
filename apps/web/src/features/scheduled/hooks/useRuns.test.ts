/**
 * Unit tests for `useRuns`.
 *
 * Layer: unit.
 * Goal: loads a job's runs, with and without the live polling interval enabled.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';

import { LIVE_POLL_MS, useRuns } from './useRuns';

afterEach(() => {
  resetScheduledStore();
});

describe('useRuns', () => {
  /** Loads the job's runs with polling disabled. */
  it('loads the runs (not live)', async () => {
    const { result } = renderHook(() => useRuns('job-changelog', { live: false }));
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data?.length).toBeGreaterThan(0);
  });

  /** Loads the job's runs with polling enabled. */
  it('loads the runs (live)', async () => {
    const { result } = renderHook(() => useRuns('job-changelog', { live: true }));
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data?.length).toBeGreaterThan(0);
  });

  /**
   * "Live" means the list keeps itself up to date. A run in progress produces no event this table
   * listens to, so without the poll a run started from the row above sits at "queued" until the
   * page is reloaded — which is exactly the moment the operator is watching it.
   */
  it('polls while live, and only while live', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.spyOn(globalThis, 'fetch');
    try {
      const { result, rerender } = renderHook(
        ({ live }: { live: boolean }) => useRuns('job-changelog', { live }),
        { initialProps: { live: true } },
      );
      await waitFor(() => {
        expect(result.current.status).toBe('success');
      });
      const before = spy.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
      });
      const polled = spy.mock.calls.length;
      expect(polled).toBeGreaterThan(before);

      rerender({ live: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 3);
      });

      expect(spy.mock.calls.length).toBe(polled);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});
