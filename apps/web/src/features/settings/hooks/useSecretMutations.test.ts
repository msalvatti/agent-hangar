/**
 * Unit tests for `useSecretMutations`.
 *
 * Layer: unit.
 * Goal: `save` succeeds and clears any prior error; a server error is surfaced under the field's
 * key and `save` resolves `false`; `remove` succeeds and resolves `true`, and a failure resolves
 * `false`; `clearError` clears a field's error; pending state is set while a mutation is in
 * flight and cleared afterwards regardless of outcome.
 * Mocks: MSW node server serving `src/mocks/settings.ts`, with `server.use` overrides for the
 * failure cases.
 */
import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { act, renderHook, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';

import { server } from '@/mocks/server';
import { resetStore } from '@/mocks/store';

import { useSecretMutations } from './useSecretMutations';

afterEach(() => {
  resetStore();
});

describe('save', () => {
  /** A successful save clears the field's pending state and leaves no error. */
  it('saves a secret and clears pending', async () => {
    const { result } = renderHook(() => useSecretMutations());
    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.save('GITHUB_PAT', GITHUB_CANARY);
    });
    expect(saved).toBe(true);
    expect(result.current.pending.GITHUB_PAT).toBeUndefined();
    expect(result.current.errors.GITHUB_PAT).toBeUndefined();
  });

  /** Pending is set to `saving` while the request is in flight. */
  it('sets pending to saving while in flight', async () => {
    const { result } = renderHook(() => useSecretMutations());
    let pendingSave: Promise<boolean>;
    act(() => {
      pendingSave = result.current.save('GITHUB_PAT', GITHUB_CANARY);
    });
    await waitFor(() => {
      expect(result.current.pending.GITHUB_PAT).toBe('saving');
    });
    await act(async () => {
      await pendingSave;
    });
  });

  /** A server error is recorded under the field's key and `save` resolves `false`. */
  it('surfaces a server error under the field key', async () => {
    server.use(
      http.put('/api/settings/:key', () =>
        HttpResponse.json({ error: { code: 'VALIDATION', message: 'too short' } }, { status: 400 }),
      ),
    );
    const { result } = renderHook(() => useSecretMutations());
    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.save('GITHUB_PAT', GITHUB_CANARY);
    });
    expect(saved).toBe(false);
    expect(result.current.errors.GITHUB_PAT).toBe('too short');
  });

  /** A non-`ApiClientError` failure falls back to a generic message. */
  it('falls back to a generic message for a non-ApiClientError failure', async () => {
    server.use(http.put('/api/settings/:key', () => HttpResponse.error()));
    const { result } = renderHook(() => useSecretMutations());
    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.save('GITHUB_PAT', GITHUB_CANARY);
    });
    expect(saved).toBe(false);
    expect(result.current.errors.GITHUB_PAT).toBe('Could not save value');
  });
});

describe('remove', () => {
  /** A successful remove resolves `true` and clears pending. */
  it('removes a secret', async () => {
    const { result } = renderHook(() => useSecretMutations());
    await act(async () => {
      await result.current.save('OPENAI_API_KEY', OPENAI_CANARY);
    });
    let removed: boolean | undefined;
    await act(async () => {
      removed = await result.current.remove('OPENAI_API_KEY');
    });
    expect(removed).toBe(true);
    expect(result.current.pending.OPENAI_API_KEY).toBeUndefined();
  });

  /** A failed remove resolves `false`. */
  it('resolves false when the remove request fails', async () => {
    server.use(http.delete('/api/settings/:key', () => HttpResponse.error()));
    const { result } = renderHook(() => useSecretMutations());
    let removed: boolean | undefined;
    await act(async () => {
      removed = await result.current.remove('GITHUB_PAT');
    });
    expect(removed).toBe(false);
  });
});

describe('clearError', () => {
  /** Clears a field's recorded error. */
  it('clears a field error', async () => {
    server.use(
      http.put('/api/settings/:key', () =>
        HttpResponse.json({ error: { code: 'VALIDATION', message: 'too short' } }, { status: 400 }),
      ),
    );
    const { result } = renderHook(() => useSecretMutations());
    await act(async () => {
      await result.current.save('GITHUB_PAT', GITHUB_CANARY);
    });
    expect(result.current.errors.GITHUB_PAT).toBe('too short');
    act(() => {
      result.current.clearError('GITHUB_PAT');
    });
    expect(result.current.errors.GITHUB_PAT).toBeUndefined();
  });
});
