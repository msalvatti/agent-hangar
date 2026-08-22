/**
 * Tests for `useChatActions`: every header action, its toast and what follows it.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/mocks/server';
import { store } from '@/mocks/store';

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
  });

  /**
   * Renaming updates the title in the store.
   */
  it('renames the chat', async () => {
    const { result } = renderHook(() => useChatActions('chat-finished'));
    await act(async () => {
      await result.current.rename('New title');
    });
    expect(store.chats.find((entry) => entry.chat.id === 'chat-finished')?.chat.title).toBe(
      'New title',
    );
  });

  /**
   * Cancelling marks the turn cancelled.
   */
  it('cancels a running turn', async () => {
    const { result } = renderHook(() => useChatActions('chat-running'));
    await act(async () => {
      await result.current.cancel('turn-running-1');
    });
    expect(store.chats.find((entry) => entry.chat.id === 'chat-running')?.turns[0]?.status).toBe(
      'CANCELLED',
    );
  });

  /**
   * Deleting removes the chat and takes the operator somewhere that still exists.
   */
  it('deletes the chat and navigates away', async () => {
    const { result } = renderHook(() => useChatActions('chat-finished'));
    await act(async () => {
      await result.current.remove();
    });
    expect(store.chats.some((entry) => entry.chat.id === 'chat-finished')).toBe(false);
    expect(push).toHaveBeenCalledWith('/chats/new');
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
});
