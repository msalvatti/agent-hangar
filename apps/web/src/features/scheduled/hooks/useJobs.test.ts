/**
 * Unit tests for `useJobs`.
 *
 * Layer: unit.
 * Goal: the hook loads the seeded jobs and exposes them once the query settles.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { registerMockServer } from '@/mocks/vitest';

import { useJobs } from './useJobs';

registerMockServer();

afterEach(() => {
  resetScheduledStore();
});

describe('useJobs', () => {
  /** Resolves to the seeded jobs once loaded. */
  it('loads the seeded jobs', async () => {
    const { result } = renderHook(() => useJobs());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data?.length).toBe(3);
  });
});
