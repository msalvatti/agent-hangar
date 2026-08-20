/**
 * Tests for `useChatActions`: every header action, its toast and what follows it.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/mocks/server';
import { store } from '@/mocks/store';

import { useChatActions } from './useChatActions';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

describe('useChatActions', () => {
  beforeEach(() => {
    push.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Archiving flips the stored status and says so.
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

  // Restoring is the inverse and reports its own message.
  it('restores the chat', async () => {
    const success = vi.spyOn(toast, 'success').mockImplementation(() => '');
    const { result } = renderHook(() => useChatActions('chat-archived'));
    await act(async () => {
      await result.current.restore();
    });
    expect(success).toHaveBeenCalledWith('Chat restored');
  });

  // Renaming updates the title in the store.
  it('renames the chat', async () => {
    const { result } = renderHook(() => useChatActions('chat-finished'));
    await act(async () => {
      await result.current.rename('New title');
    });
    expect(store.chats.find((entry) => entry.chat.id === 'chat-finished')?.chat.title).toBe(
      'New title',
    );
  });

  // Cancelling marks the turn cancelled.
  it('cancels a running turn', async () => {
    const { result } = renderHook(() => useChatActions('chat-running'));
    await act(async () => {
      await result.current.cancel('turn-running-1');
    });
    expect(store.chats.find((entry) => entry.chat.id === 'chat-running')?.turns[0]?.status).toBe(
      'CANCELLED',
    );
  });

  // Deleting removes the chat and takes the operator somewhere that still exists.
  it('deletes the chat and navigates away', async () => {
    const { result } = renderHook(() => useChatActions('chat-finished'));
    await act(async () => {
      await result.current.remove();
    });
    expect(store.chats.some((entry) => entry.chat.id === 'chat-finished')).toBe(false);
    expect(push).toHaveBeenCalledWith('/chats/new');
  });

  // Copying the id is a clipboard action with its own confirmation.
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

  // Callers discard the promise this action returns, so a denied clipboard permission has to be
  // handled here: otherwise it becomes an unhandled rejection and the operator sees nothing.
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

  // A failing action explains itself instead of failing silently.
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

  // A rejection that is not an `Error` still produces a readable toast.
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

  // The busy flag is what disables the button while the request is in flight.
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
});
