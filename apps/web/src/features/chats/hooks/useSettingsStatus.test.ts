/**
 * Tests for `useSettingsStatus`: the credential gate the home composer reads.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { setScenario } from '@/mocks/scenario';
import { server } from '@/mocks/server';
import { invalidateQueries } from '@/shared/api/use-api-query';

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

  /**
   * The gate opens on either credential being absent, not on both. The agent needs a model key to
   * answer and a forge token to clone; a chat started with one of the two fails inside the
   * workspace, where the operator is given no way to fix it.
   */
  it.each([
    ['only the GitHub token is stored', true, false],
    ['only the OpenAI key is stored', false, true],
  ])('reports missing when %s', async (_label, githubSet, openaiSet) => {
    server.use(
      http.get('/api/settings', () =>
        HttpResponse.json({
          githubPat: githubSet ? { set: true, last4: 'aaaa' } : { set: false },
          openaiKey: openaiSet ? { set: true, last4: 'bbbb' } : { set: false },
          model: 'gpt-5.6-sol',
        }),
      ),
    );
    const { result } = renderHook(() => useSettingsStatus());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect(result.current.missing).toBe(true);
  });

  /**
   * The status is registered under the key the settings page invalidates after storing a
   * credential. Registered under anything else, the home screen goes on refusing to start a chat
   * until the page is reloaded.
   */
  it('refetches when the settings key is invalidated', async () => {
    const { result } = renderHook(() => useSettingsStatus());
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    act(() => {
      invalidateQueries(['settings']);
    });

    await waitFor(() => {
      expect(result.current.isRefetching).toBe(true);
    });
    await waitFor(() => {
      expect(result.current.isRefetching).toBe(false);
    });
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
