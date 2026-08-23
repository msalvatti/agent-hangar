/**
 * Unit tests for `useRun`.
 *
 * Layer: unit.
 * Goal: loads the run detail when a runId is given, and stays idle (no request) when it is null.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { invalidateQueries } from '@/shared/api/use-api-query';

import { runKey } from '../lib/query-keys';

import { buildRunLoader, useRun } from './useRun';

afterEach(() => {
  resetScheduledStore();
});

describe('useRun', () => {
  /** Loads the run detail for a given id. */
  it('loads the run detail', async () => {
    const { result } = renderHook(() => useRun('run-nightly-success'));
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data?.run.id).toBe('run-nightly-success');
  });

  /**
   * Each run is registered under its own id. Two run drawers can be open across a navigation, and
   * a shared key would serve one run's detail as the other's — and would make a stop on one refresh
   * both.
   */
  it('registers each run under its own key', async () => {
    const first = renderHook(() => useRun('run-nightly-success'));
    const second = renderHook(() => useRun('run-nightly-running'));
    await waitFor(() => {
      expect(first.result.current.status).toBe('success');
      expect(second.result.current.status).toBe('success');
    });

    act(() => {
      invalidateQueries(runKey('run-nightly-success'));
    });

    await waitFor(() => {
      expect(first.result.current.isRefetching).toBe(true);
    });
    expect(second.result.current.isRefetching).toBe(false);
    await waitFor(() => {
      expect(first.result.current.isRefetching).toBe(false);
    });
  });

  /** Stays idle and issues no request when runId is null. */
  it('stays idle when runId is null', () => {
    const { result } = renderHook(() => useRun(null));
    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });
});

describe('buildRunLoader', () => {
  /** Rejects immediately when built for a null runId (the guard `useRun`'s `enabled: false` keeps
   * unreachable through the hook itself). */
  it('rejects when runId is null', async () => {
    const controller = new AbortController();
    await expect(buildRunLoader(null)(controller.signal)).rejects.toThrow(
      'useRun called with no run id',
    );
  });
});
