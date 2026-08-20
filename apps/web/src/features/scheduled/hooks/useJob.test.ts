/**
 * Unit tests for `useJob`.
 *
 * Layer: unit.
 * Goal: resolves the matching job from the jobs list, and sets `notFound` once loaded with no
 * match.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';

import { useJob } from './useJob';

afterEach(() => {
  resetScheduledStore();
});

describe('useJob', () => {
  /** Resolves the job matching the given id. */
  it('resolves the matching job', async () => {
    const { result } = renderHook(() => useJob('job-dep-audit'));
    await waitFor(() => {
      expect(result.current.data?.id).toBe('job-dep-audit');
    });
    expect(result.current.notFound).toBe(false);
  });

  /** Sets notFound once loaded with no matching job. */
  it('sets notFound for an unknown id', async () => {
    const { result } = renderHook(() => useJob('missing'));
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.notFound).toBe(true);
    expect(result.current.data).toBeUndefined();
  });
});
