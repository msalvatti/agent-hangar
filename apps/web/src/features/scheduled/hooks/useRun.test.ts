/**
 * Unit tests for `useRun`.
 *
 * Layer: unit.
 * Goal: loads the run detail when a runId is given, and stays idle (no request) when it is null.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { registerMockServer } from '@/mocks/vitest';

import { buildRunLoader, useRun } from './useRun';

registerMockServer();

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
