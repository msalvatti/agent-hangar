/**
 * Unit tests for `useHealthSummary`.
 *
 * Layer: unit.
 * Goal: loads and summarizes the health response for the default (healthy) and `infra-down`
 * scenarios.
 * Mocks: MSW node server serving `src/mocks/health.ts`.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { setScenario } from '@/mocks/scenario';
import { registerMockServer } from '@/mocks/vitest';

import { useHealthSummary } from './useHealthSummary';

registerMockServer();

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
});
