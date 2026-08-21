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

  /**
   * With a repo, it fetches and hands the listing back in the order the route sent it.
   *
   * The order is the assertion, not an incidental detail: this hook sorts nothing and must not, so
   * that the picker above it chooses the default branch by name. The seeded listing is the forge's
   * own — alphabetical, so `main` is last — and an implementation that reordered it towards the
   * default would fail here rather than hide the position a caller must never trust.
   */
  it('fetches branches once a repo is chosen', async () => {
    const { result } = renderHook(() => useBranches('acme/api'));
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data?.branches.map((branch) => branch.name)).toEqual([
      'agent/k3x9',
      'develop',
      'main',
    ]);
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
