/**
 * Unit tests for `useHealthSummary`.
 *
 * Layer: unit.
 * Goal: loads and summarizes the health response for the default (healthy) and `infra-down`
 * scenarios.
 * Mocks: MSW node server serving `src/mocks/health.ts`.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setScenario } from '@/mocks/scenario';
import { invalidateQueries } from '@/shared/api/use-api-query';
import { HEALTH_POLL_MS } from '@/shared/health';

import { useHealthSummary } from './useHealthSummary';

afterEach(() => {
  setScenario('default');
});

describe('useHealthSummary', () => {
  /** Loads a healthy summary by default. */
  it('loads a healthy summary', async () => {
    const { result } = renderHook(() => useHealthSummary());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data?.allOk).toBe(true);
    expect(result.current.data?.checks.every((check) => check.ok)).toBe(true);
  });

  /** Under `infra-down`, the summary reports the infrastructure checks unhealthy. */
  it('loads an unhealthy summary under infra-down', async () => {
    setScenario('infra-down');
    const { result } = renderHook(() => useHealthSummary());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data?.allOk).toBe(false);
  });

  /**
   * The card reads the same report the sidebar pill does, under the same key, so the two cannot
   * disagree about how current they are — and a credential saved on this very page invalidates
   * that key, which is what refreshes the card without a reload.
   */
  it('refetches when the health key is invalidated', async () => {
    const { result } = renderHook(() => useHealthSummary());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    act(() => {
      invalidateQueries(['health']);
    });

    await waitFor(() => {
      expect(result.current.isRefetching).toBe(true);
    });
    await waitFor(() => {
      expect(result.current.isRefetching).toBe(false);
    });
  });

  /**
   * The card is a live reading of the environment, so it polls. Left unpolled it shows the state of
   * the machine at the moment the page was opened, for as long as the tab stays open — which is
   * exactly the reading an operator uses to decide whether the infrastructure came back up.
   */
  it('polls the report on the same period as the sidebar pill', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.spyOn(globalThis, 'fetch');
    try {
      const { result } = renderHook(() => useHealthSummary());
      await waitFor(() => {
        expect(result.current.status).toBe('success');
      });
      const before = spy.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(HEALTH_POLL_MS);
      });

      expect(spy.mock.calls.length).toBeGreaterThan(before);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});
