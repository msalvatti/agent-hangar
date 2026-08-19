/**
 * Tests for `useHealth`: the derived state behind the environment pill.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { setScenario } from '@/mocks/scenario';

import { useHealth } from './useHealth';

describe('useHealth', () => {
  // A healthy environment reports ok with nothing failing.
  it('reports a healthy environment', async () => {
    const { result } = renderHook(() => useHealth());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.ok).toBe(true);
    expect(result.current.failing).toEqual([]);
  });

  // Before the first report nothing is claimed to be healthy.
  it('is not ok before the first report', () => {
    const { result } = renderHook(() => useHealth());
    expect(result.current.ok).toBe(false);
    expect(result.current.failing).toEqual([]);
  });

  // The failing probes are named so the pill's label can say which ones they are.
  it('names the failing probes', async () => {
    setScenario('infra-down');
    const { result } = renderHook(() => useHealth());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.ok).toBe(false);
    expect(result.current.failing).toEqual(['Redis', 'Docker']);
  });
});
