/**
 * Unit tests for `useSettings`.
 *
 * Layer: unit.
 * Goal: loads the masked settings status.
 * Mocks: MSW node server serving `src/mocks/settings-status.ts`.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { resetStore } from '@/mocks/store';
import { registerMockServer } from '@/mocks/vitest';

import { useSettings } from './useSettings';

registerMockServer();

afterEach(() => {
  resetStore();
});

describe('useSettings', () => {
  /** Loads the settings status, both secrets unset by default. */
  it('loads the settings status', async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data?.githubPat.set).toBe(false);
  });
});
