/**
 * Tests for the branch-list hook: disabled without a repo, fetches once one is chosen.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useBranches } from './useBranches';

describe('useBranches', () => {
  // With no repo, the query stays idle and never fetches.
  it('stays idle when repo is null', () => {
    const { result } = renderHook(() => useBranches(null));
    expect(result.current.status).toBe('idle');
  });

  // With a repo, it fetches and returns the seeded branches, default branch first.
  it('fetches branches once a repo is chosen', async () => {
    const { result } = renderHook(() => useBranches('acme/api'));
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data?.branches[0]?.name).toBe('main');
  });

  // `refetch()` has no `enabled` guard of its own (unlike the query's automatic effects), so a
  // caller invoking it while `repo` is still null reaches the loader's `repo ?? ''` fallback.
  it('does not throw when refetch is called before a repo is chosen', async () => {
    const { result } = renderHook(() => useBranches(null));
    await act(async () => {
      await expect(result.current.refetch()).resolves.toBeUndefined();
    });
  });
});
