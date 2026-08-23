/**
 * Tests for `useChatActions`: every header action, its toast and what follows it.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/mocks/server';
import { store } from '@/mocks/store';
import { useApiQuery } from '@/shared/api/use-api-query';

import { useChat } from './useChat';
import { useChatActions } from './useChatActions';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

describe('useChatActions', () => {
  beforeEach(() => {
    push.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // The request counter below subscribes to the shared server; left attached it would keep
    // counting into the next test's total.
    server.events.removeAllListeners();
  });

  /**
   * Archiving flips the stored status and says so.
   */
  it('archives the chat', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const { result } = renderHook(() => useChatActions('chat-finished'));
    await act(async () => {
      await result.current.archive();
    });
    expect(store.chats.find((entry) => entry.chat.id === 'chat-finished')?.chat.status).toBe(
      'ARCHIVED',
    );
    expect(success).toHaveBeenCalledWith('Chat archived');
  });

  /**
   * Restoring is the inverse and reports its own message.
   */
  it('restores the chat', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const { result } = renderHook(() => useChatActions('chat-archived'));
    await act(async () => {
      await result.current.restore();
    });
    expect(success).toHaveBeenCalledWith('Chat restored');
    // The flag is keyed by the action's own name: the menu disables one item while it runs, and a
    // shared key would grey out every item on the menu instead.
    expect(result.current.busy).toStrictEqual({ restore: false });
  });

  /**
   * Renaming updates the title in the store.
   */
  it('renames the chat', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const { result } = renderHook(() => useChatActions('chat-finished'));
    await act(async () => {
      await result.current.rename('New title');
    });
    expect(store.chats.find((entry) => entry.chat.id === 'chat-finished')?.chat.title).toBe(
      'New title',
    );
    expect(success).toHaveBeenCalledWith('Chat renamed');
    expect(result.current.busy).toStrictEqual({ rename: false });
  });

  /**
   * Cancelling marks the turn cancelled.
   */
  it('cancels a running turn', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const { result } = renderHook(() => useChatActions('chat-running'));
    await act(async () => {
      await result.current.cancel('turn-running-1');
    });
    expect(store.chats.find((entry) => entry.chat.id === 'chat-running')?.turns[0]?.status).toBe(
      'CANCELLED',
    );
    // "Stopped", which is what the operator asked for and what the transcript's own notice says.
    expect(success).toHaveBeenCalledWith('Turn stopped');
    expect(result.current.busy).toStrictEqual({ cancel: false });
  });

  /**
   * Deleting removes the chat and takes the operator somewhere that still exists.
   */
  it('deletes the chat and navigates away', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const { result } = renderHook(() => useChatActions('chat-finished'));
    await act(async () => {
      await result.current.remove();
    });
    expect(store.chats.some((entry) => entry.chat.id === 'chat-finished')).toBe(false);
    expect(push).toHaveBeenCalledWith('/chats/new');
    expect(success).toHaveBeenCalledWith('Chat deleted');
    expect(result.current.busy).toStrictEqual({ remove: false });
  });

  /**
   * Copying the id is a clipboard action with its own confirmation.
   */
  it('copies the chat id', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { result } = renderHook(() => useChatActions('chat-finished'));
    await act(async () => {
      await result.current.copyId();
    });
    expect(writeText).toHaveBeenCalledWith('chat-finished');
    expect(success).toHaveBeenCalledWith('Chat id copied');
  });

  /**
   * Callers discard the promise this action returns, so a denied clipboard permission has to be
   * handled here: otherwise it becomes an unhandled rejection and the operator sees nothing.
   */
  it('reports a refused clipboard instead of rejecting', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    const writeText = vi.fn().mockRejectedValue(new Error('Write permission denied'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { result } = renderHook(() => useChatActions('chat-finished'));
    await act(async () => {
      await expect(result.current.copyId()).resolves.toBeUndefined();
    });
    expect(error).toHaveBeenCalledWith('Copy failed');
  });

  /**
   * A failing action explains itself instead of failing silently.
   */
  it('reports a failure as an error toast', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    server.use(
      http.post('/api/chats/:id/archive', () =>
        HttpResponse.json({ error: { code: 'BOOM', message: 'nope' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useChatActions('chat-finished'));
    await act(async () => {
      await result.current.archive();
    });
    expect(error).toHaveBeenCalledWith('nope');
  });

  /**
   * A rejection that is not an `Error` still produces a readable toast.
   */
  it('reports a non-Error rejection', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue('socket closed');
    try {
      const { result } = renderHook(() => useChatActions('chat-finished'));
      await act(async () => {
        await result.current.archive();
      });
      expect(error).toHaveBeenCalledWith('socket closed');
    } finally {
      globalThis.fetch = original;
    }
  });

  /**
   * The busy flag is what disables the button while the request is in flight.
   */
  it('reports the action as busy while it runs', async () => {
    const { result } = renderHook(() => useChatActions('chat-finished'));
    let pending: Promise<void> | null = null;
    act(() => {
      pending = result.current.archive();
    });
    await waitFor(() => {
      expect(result.current.busy.archive).toBe(true);
    });
    await act(async () => {
      await pending;
    });
    expect(result.current.busy.archive).toBe(false);
  });

  /**
   * Counts requests for one chat's detail while a hook that reads it stays mounted.
   *
   * @param id - Chat id whose detail requests are counted.
   * @returns The mounted hooks and a live counter.
   */
  function renderWithDetailCounter(id: string): {
    actions: { current: ReturnType<typeof useChatActions> };
    detailRequests: () => number;
  } {
    let count = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'GET' && new URL(request.url).pathname === `/api/chats/${id}`) {
        count += 1;
      }
    });
    const { result } = renderHook(() => ({ chat: useChat(id), actions: useChatActions(id) }));
    return {
      actions: {
        get current() {
          return result.current.actions;
        },
      },
      detailRequests: () => count,
    };
  }

  /**
   * Cancelling must not refetch the chat: the turn's event stream is the fresher record of the turn
   * on screen, and persistence trails it — the turn is cancelled the moment the request is
   * accepted, while the tool call it interrupted is only closed when the runtime reports back. A
   * refetch inside that window reseeds the transcript with a tool row still reading "running" and
   * closes the stream that would have corrected it, which is what left a spinner on screen for the
   * rest of the page's life.
   */
  it('does not refetch the chat when a turn is cancelled', async () => {
    const { actions, detailRequests } = renderWithDetailCounter('chat-running');
    await waitFor(() => {
      expect(detailRequests()).toBe(1);
    });
    await act(async () => {
      await actions.current.cancel('turn-running-1');
    });
    expect(detailRequests()).toBe(1);
  });

  /**
   * Every other action changes the chat outside any stream, so its result exists nowhere else and
   * the detail has to be fetched again. This is the counterpart of the check above: without it,
   * suppressing the refetch for all actions would pass just as well.
   */
  it('refetches the chat when it is renamed', async () => {
    const { actions, detailRequests } = renderWithDetailCounter('chat-finished');
    await waitFor(() => {
      expect(detailRequests()).toBe(1);
    });
    await act(async () => {
      await actions.current.rename('Renamed while mounted');
    });
    await waitFor(() => {
      expect(detailRequests()).toBe(2);
    });
  });

  /**
   * The sidebar renders each chat's title and its status dot from the listing, not from the chat's
   * own detail, so an action that changed either has to reload the listing as well — otherwise the
   * chat the operator just archived goes on sitting in the active section.
   */
  it('reloads the chat lists after an action', async () => {
    const chats = vi.fn(() => Promise.resolve('chats'));
    const { result } = renderHook(() => {
      useApiQuery(['chats', 'ACTIVE'], chats);
      return useChatActions('chat-finished');
    });
    await waitFor(() => {
      expect(chats).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.archive();
    });

    await waitFor(() => {
      expect(chats).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * What is reloaded is this chat and the lists, and nothing else. An invalidation broad enough to
   * match every key would reload every screen the app has open on the strength of one rename.
   */
  it('leaves unrelated queries alone', async () => {
    const settings = vi.fn(() => Promise.resolve('settings'));
    const { result } = renderHook(() => {
      useApiQuery(['settings'], settings);
      return useChatActions('chat-finished');
    });
    await waitFor(() => {
      expect(settings).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await result.current.rename('Renamed again');
    });

    expect(settings).toHaveBeenCalledTimes(1);
  });

  /**
   * The actions follow the chat the hook is currently given. Bound to the id it first saw, an
   * action taken after the operator navigated to another chat would refresh the one they left and
   * leave the one in front of them showing what it said before.
   */
  it('refetches the chat it is currently given, not the one it started on', async () => {
    let first = 0;
    let second = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.method !== 'GET') {
        return;
      }
      const { pathname } = new URL(request.url);
      if (pathname === '/api/chats/chat-finished') {
        first += 1;
      }
      if (pathname === '/api/chats/chat-archived') {
        second += 1;
      }
    });

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => {
        useChat('chat-finished');
        useChat('chat-archived');
        return useChatActions(id);
      },
      { initialProps: { id: 'chat-finished' } },
    );
    await waitFor(() => {
      expect(first).toBe(1);
      expect(second).toBe(1);
    });

    rerender({ id: 'chat-archived' });
    await act(async () => {
      await result.current.rename('Renamed on the second chat');
    });

    await waitFor(() => {
      expect(second).toBe(2);
    });
    expect(first).toBe(1);
  });
});
