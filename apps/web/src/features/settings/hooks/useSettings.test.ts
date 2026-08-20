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

import { useSettings } from './useSettings';

afterEach(() => {
  resetStore();
});

describe('useSettings', () => {
  /** Loads the masked status of the seeded instance's credentials. */
  it('loads the settings status', async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data?.githubPat).toMatchObject({ set: true, last4: 'ab12' });
  });
});
