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
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/mocks/server';
import { resetStore } from '@/mocks/store';
import { useApiQuery } from '@/shared/api/use-api-query';

import { useSecretMutations } from './useSecretMutations';

afterEach(() => {
  resetStore();
  vi.restoreAllMocks();
});

/**
 * Mounts the hook next to the settings query, so a mutation asking that query to reload is
 * observable rather than a call nothing watches.
 *
 * @returns The hook's result and a count of the settings loader's calls.
 */
function renderWithSettings(): {
  result: { current: ReturnType<typeof useSecretMutations> };
  settings: () => number;
} {
  const loader = vi.fn(() => Promise.resolve('settings'));
  const { result } = renderHook(() => {
    useApiQuery(['settings'], loader);
    return useSecretMutations();
  });
  return { result, settings: () => loader.mock.calls.length };
}

describe('save', () => {
  /** A successful save clears the field's pending state and leaves no error. */
  it('saves a secret and clears pending', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const { result, settings } = renderWithSettings();
    await waitFor(() => {
      expect(settings()).toBe(1);
    });

    let saved: boolean | undefined;
    await act(async () => {
      saved = await result.current.save('GITHUB_PAT', GITHUB_CANARY);
    });

    expect(saved).toBe(true);
    expect(result.current.pending).toStrictEqual({});
    expect(result.current.errors).toStrictEqual({});
    // The credential is named the way the card names it, so the toast reads as being about the
    // field the user just filled in rather than about an internal key.
    expect(success).toHaveBeenCalledWith('GitHub token saved');
    // And the settings query reloads: what the card shows — configured or not, and when it was
    // last changed — is server state that this save has just invalidated.
    await waitFor(() => {
      expect(settings()).toBe(2);
    });
  });

  /** The other credential is named after itself, not after whichever field was written first. */
  it('names the OpenAI key in its own toast', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const { result } = renderHook(() => useSecretMutations());
    await act(async () => {
      await result.current.save('OPENAI_API_KEY', OPENAI_CANARY);
    });
    expect(success).toHaveBeenCalledWith('OpenAI API key saved');
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

  /**
   * What reloads is the settings status. An invalidation broad enough to match every key reloads
   * the chat lists, the health poll and everything else the page holds, because one field was
   * saved.
   */
  it('leaves unrelated queries alone', async () => {
    const chats = vi.fn(() => Promise.resolve('chats'));
    const { result } = renderHook(() => {
      useApiQuery(['chats', 'ACTIVE'], chats);
      return useSecretMutations();
    });
    await waitFor(() => {
      expect(chats).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.save('GITHUB_PAT', GITHUB_CANARY);
    });

    expect(chats).toHaveBeenCalledTimes(1);
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
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const { result, settings } = renderWithSettings();
    await act(async () => {
      await result.current.save('OPENAI_API_KEY', OPENAI_CANARY);
    });
    await waitFor(() => {
      expect(settings()).toBe(2);
    });

    let removed: boolean | undefined;
    await act(async () => {
      removed = await result.current.remove('OPENAI_API_KEY');
    });

    expect(removed).toBe(true);
    expect(result.current.pending).toStrictEqual({});
    expect(success).toHaveBeenCalledWith('OpenAI API key removed');
    await waitFor(() => {
      expect(settings()).toBe(3);
    });
  });

  /**
   * The field is marked as removing — not as saving, and not only itself: the card disables the
   * one row that is busy, and a state that wiped the other field's would unlock a request already
   * in flight.
   */
  it('marks only the field being removed, and marks it as removing', async () => {
    const held: (() => void)[] = [];
    const hold = async (): Promise<void> => {
      await new Promise<void>((resolve) => held.push(resolve));
    };
    server.use(
      http.delete('/api/settings/:key', async () => {
        await hold();
        return new HttpResponse(null, { status: 204 });
      }),
      http.put('/api/settings/:key', async () => {
        await hold();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { result } = renderHook(() => useSecretMutations());

    let inFlight: Promise<boolean> = Promise.resolve(false);
    let saving: Promise<boolean> = Promise.resolve(false);
    act(() => {
      saving = result.current.save('GITHUB_PAT', GITHUB_CANARY);
      inFlight = result.current.remove('OPENAI_API_KEY');
    });
    await waitFor(() => {
      expect(result.current.pending.OPENAI_API_KEY).toBe('removing');
    });
    expect(result.current.pending.GITHUB_PAT).toBe('saving');

    await act(async () => {
      for (const release of held) {
        release();
      }
      await Promise.all([inFlight, saving]);
    });
    expect(result.current.pending).toStrictEqual({});
  });

  /** A failed remove resolves `false`. */
  it('resolves false when the remove request fails', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    server.use(http.delete('/api/settings/:key', () => HttpResponse.error()));
    const { result } = renderHook(() => useSecretMutations());
    let removed: boolean | undefined;
    await act(async () => {
      removed = await result.current.remove('GITHUB_PAT');
    });
    expect(removed).toBe(false);
    // A remove has no field to report under — the value is gone from the input either way — so the
    // toast is the only place the failure is told, and it names which credential is still stored.
    expect(error).toHaveBeenCalledWith('Could not remove GitHub token');
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
