/**
 * Unit tests for `useRuns`.
 *
 * Layer: unit.
 * Goal: loads a job's runs, with and without the live polling interval enabled.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { registerMockServer } from '@/mocks/vitest';

import { useRuns } from './useRuns';

registerMockServer();

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
});
