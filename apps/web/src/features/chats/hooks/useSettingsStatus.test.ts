/**
 * Tests for `useSettingsStatus`: the credential gate the home composer reads.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { setScenario } from '@/mocks/scenario';
import { server } from '@/mocks/server';

import { useSettingsStatus } from './useSettingsStatus';

describe('useSettingsStatus', () => {
  // With both credentials stored, the gate is closed and the composer renders.
  it('reports nothing missing when both credentials are set', async () => {
    const { result } = renderHook(() => useSettingsStatus());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.missing).toBe(false);
    expect(result.current.data?.model).not.toHaveLength(0);
  });

  // The `missing-settings` scenario empties the store, which must open the gate.
  it('reports missing when a credential is absent', async () => {
    setScenario('missing-settings');
    const { result } = renderHook(() => useSettingsStatus());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.missing).toBe(true);
  });

  // Before the first response arrives nothing is known, so the gate stays closed.
  it('does not report missing while the status is still unknown', () => {
    const { result } = renderHook(() => useSettingsStatus());
    expect(result.current.missing).toBe(false);
  });

  // A failing request surfaces as an error the view turns into an ErrorCard.
  it('surfaces a request failure', async () => {
    server.use(
      http.get('/api/settings', () =>
        HttpResponse.json({ error: { code: 'BOOM', message: 'nope' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useSettingsStatus());
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error?.message).toBe('nope');
  });
});
