/**
 * Tests for `useRetryTurn`: re-running a failed turn and reporting a refusal.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { store } from '@/mocks/store';

import { useRetryTurn } from './useRetryTurn';

/**
 * Counts the persisted USER messages of a chat, which is what a retry must not add to.
 *
 * @param chatId - Chat to read.
 * @returns How many USER rows the mock store holds for it.
 */
function userRows(chatId: string): number {
  const entry = store.chats.find((candidate) => candidate.chat.id === chatId);
  return (entry?.messages ?? []).filter((message) => message.role === 'USER').length;
}

describe('useRetryTurn', () => {
  /**
   * The whole point of the operation: the turn goes back to `QUEUED` and the chat's persisted
   * history is untouched. Both are read out of the store rather than inferred from the call, so a
   * retry that started writing messages again would fail here.
   */
  it('re-queues the failed turn and persists no new user message', async () => {
    const before = userRows('chat-failed');
    const { result } = renderHook(() => useRetryTurn());
    let queued = false;

    await act(async () => {
      queued = await result.current.retry('turn-failed-1');
    });

    expect(queued).toBe(true);
    expect(result.current.error).toBeUndefined();
    expect(result.current.busy).toBe(false);
    expect(userRows('chat-failed')).toBe(before);
    const entry = store.chats.find((candidate) => candidate.chat.id === 'chat-failed');
    expect(entry?.turns).toHaveLength(1);
    expect(entry?.turns[0]).toMatchObject({ id: 'turn-failed-1', status: 'QUEUED', error: null });
  });

  /**
   * A turn that did not fail is refused, and the reason is kept rather than swallowed: the screen
   * changes in no other way when a retry is refused, so the message is the only feedback there is.
   */
  it('reports a refusal instead of resolving true', async () => {
    const { result } = renderHook(() => useRetryTurn());
    let queued = true;

    await act(async () => {
      queued = await result.current.retry('turn-finished-1');
    });

    expect(queued).toBe(false);
    expect(result.current.error).toBeDefined();
    expect(result.current.busy).toBe(false);
  });

  /** A rejection that is not an `Error` still yields a message the screen can render. */
  it('reports a non-Error rejection', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue('socket closed');
    try {
      const { result } = renderHook(() => useRetryTurn());
      await act(async () => {
        await result.current.retry('turn-failed-1');
      });
      expect(result.current.error).toBe('socket closed');
    } finally {
      globalThis.fetch = original;
    }
  });
});
