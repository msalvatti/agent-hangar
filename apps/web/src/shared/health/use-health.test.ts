/**
 * Unit tests for the health poll and what its readers render from it.
 *
 * Layer: unit.
 * Goal: the report is fetched under a key other parts of the tree can invalidate, the poll and the
 * focus refetch are asked for, `ok` is a claim about a report that arrived rather than about the
 * absence of failures, and each failing probe carries the command that repairs it.
 * Mocks: the MSW node server serving `src/mocks/health.ts`.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setScenario } from '@/mocks/scenario';
import { invalidateQueries } from '@/shared/api/use-api-query';

import {
  getHealth,
  HEALTH_CHECK_FIX,
  HEALTH_CHECK_NAMES,
  HEALTH_POLL_MS,
  useHealth,
} from './use-health';

/** Counts the requests this file's hooks issue, whatever answers them. */
function countRequests(): { requests: () => number; restore: () => void } {
  const spy = vi.spyOn(globalThis, 'fetch');
  return {
    requests: () => spy.mock.calls.length,
    restore: () => {
      spy.mockRestore();
    },
  };
}

afterEach(() => {
  setScenario('default');
});

describe('useHealth', () => {
  /**
   * Before the first report arrives nothing is known, and "nothing failed yet" is not the same
   * claim as "everything is healthy": the banner would show a green instance for as long as the
   * request is in flight, on every page load.
   */
  it('claims nothing until a report has arrived', () => {
    const { result } = renderHook(() => useHealth());

    expect(result.current.ok).toBe(false);
    expect(result.current.failingChecks).toEqual([]);
    expect(result.current.failing).toEqual([]);
  });

  /**
   * A healthy instance reports every probe passing.
   */
  it('reports a healthy instance once the report arrives', async () => {
    const { result } = renderHook(() => useHealth());

    await waitFor(() => {
      expect(result.current.ok).toBe(true);
    });
    expect(result.current.failingChecks).toEqual([]);
  });

  /**
   * With the infrastructure down the failing probes are named, and only those.
   */
  it('names the probes that failed', async () => {
    setScenario('infra-down');
    const { result } = renderHook(() => useHealth());

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect(result.current.ok).toBe(false);
    expect(result.current.failingChecks.length).toBeGreaterThan(0);
    expect(result.current.failingChecks.every((name) => HEALTH_CHECK_NAMES.includes(name))).toBe(
      true,
    );
  });

  /**
   * The report is registered under a key the rest of the tree invalidates by name. Registered
   * under anything else, a settings page that has just stored a credential would go on showing the
   * instance as it was before.
   */
  it('refetches when the health key is invalidated', async () => {
    const { result } = renderHook(() => useHealth());
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
   * The banner is a live reading, so the report is polled and brought back up to date the moment
   * somebody looks at the window again. Without either, a health card opened once shows what the
   * instance looked like then, for as long as the tab stays open.
   */
  it('polls the report and refetches when the window is looked at', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { requests, restore } = countRequests();
    try {
      const { result } = renderHook(() => useHealth());
      await waitFor(() => {
        expect(result.current.status).toBe('success');
      });
      const polled = requests();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(HEALTH_POLL_MS);
      });
      expect(requests()).toBeGreaterThan(polled);

      const beforeFocus = requests();
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await waitFor(() => {
        expect(requests()).toBeGreaterThan(beforeFocus);
      });
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  /**
   * The request carries the caller's abort signal, so a card that unmounts while its poll is in
   * flight takes the request with it rather than leaving it to resolve into nothing.
   */
  it('passes the abort signal through to the request', async () => {
    const controller = new AbortController();
    const pending = getHealth(controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow();
  });
});

describe('what a failing probe tells the user to run', () => {
  /**
   * Each command is written out. They are what a developer types into a terminal, and four of the
   * five are commands of this repository — the fifth is not, because nothing here can start the
   * Docker daemon, so it names the application instead.
   */
  it('names one command per probe', () => {
    expect(HEALTH_CHECK_FIX).toStrictEqual({
      db: 'pnpm infra:up',
      redis: 'pnpm infra:up',
      worker: 'pnpm dev',
      docker: 'start Docker Desktop',
      image: 'pnpm infra:image',
    });
  });
});
