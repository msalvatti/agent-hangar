/**
 * Tests for `useSendMessage`: posting follow-ups and reporting what the API answered.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { server } from '@/mocks/server';

import { useSendMessage } from './useSendMessage';

describe('useSendMessage', () => {
  // A successful post returns the turn id the view then subscribes to.
  it('returns the queued turn id', async () => {
    const { result } = renderHook(() => useSendMessage('chat-finished', null));
    let turnId: string | null = null;
    await act(async () => {
      turnId = await result.current.send('And now add a test.');
    });
    expect(turnId).not.toBeNull();
    expect(result.current.error).toBeUndefined();
    expect(result.current.lastPrompt).toBe('And now add a test.');
  });

  // An archived chat refuses follow-ups, which the composer must surface.
  it('reports the archived-chat refusal', async () => {
    const { result } = renderHook(() => useSendMessage('chat-archived', null));
    let turnId: string | null = 'unset';
    await act(async () => {
      turnId = await result.current.send('continue');
    });
    expect(turnId).toBeNull();
    expect(result.current.error).toBeDefined();
    expect(result.current.busy).toBe(false);
  });

  // The prompt seeded from persisted history is reported before anything is sent through the hook.
  it('starts from the prompt seeded out of history', () => {
    const { result } = renderHook(() => useSendMessage('chat-finished', 'original prompt'));
    expect(result.current.lastPrompt).toBe('original prompt');
  });

  /**
   * The composer locks while the post is in flight and unlocks afterwards. Never locking sends the
   * same follow-up twice on a double press; never unlocking leaves the chat unusable.
   */
  it('locks the composer only while the post is in flight', async () => {
    const held: (() => void)[] = [];
    server.use(
      http.post('/api/chats/:id/messages', async () => {
        await new Promise<void>((resolve) => held.push(resolve));
        return undefined;
      }),
    );
    const { result } = renderHook(() => useSendMessage('chat-finished', null));
    expect(result.current.busy).toBe(false);

    let pending: Promise<string | null> = Promise.resolve(null);
    act(() => {
      pending = result.current.send('And now add a test.');
    });
    await waitFor(() => {
      expect(result.current.busy).toBe(true);
    });

    await act(async () => {
      for (const release of held) {
        release();
      }
      await pending;
    });
    expect(result.current.busy).toBe(false);
  });

  /**
   * A retry starts clean: the refusal of the last attempt, left under a composer the operator has
   * since rewritten, reads as a rejection of what they are about to send.
   */
  it('clears a previous failure when a follow-up is retried', async () => {
    const { result, rerender } = renderHook(({ id }: { id: string }) => useSendMessage(id, null), {
      initialProps: { id: 'chat-archived' },
    });
    await act(async () => {
      await result.current.send('continue');
    });
    expect(result.current.error).toBeDefined();

    rerender({ id: 'chat-finished' });
    await act(async () => {
      await result.current.send('continue');
    });

    expect(result.current.error).toBeUndefined();
  });

  /**
   * The follow-up goes to the chat the hook is currently given. Bound to the id it mounted on, a
   * message typed after navigating to another chat is posted into the one that was left.
   */
  it('posts to the chat it is currently given', async () => {
    const paths: string[] = [];
    server.use(
      http.post('/api/chats/:id/messages', ({ request }) => {
        paths.push(new URL(request.url).pathname);
        return undefined;
      }),
    );
    const { result, rerender } = renderHook(({ id }: { id: string }) => useSendMessage(id, null), {
      initialProps: { id: 'chat-finished' },
    });

    rerender({ id: 'chat-running' });
    await act(async () => {
      await result.current.send('and this one');
    });

    expect(paths).toEqual(['/api/chats/chat-running/messages']);
  });

  // A rejection that is not an `Error` still yields a message for the composer.
  it('reports a non-Error rejection', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue('socket closed');
    try {
      const { result } = renderHook(() => useSendMessage('chat-finished', null));
      await act(async () => {
        await result.current.send('hi');
      });
      expect(result.current.error).toBe('socket closed');
    } finally {
      globalThis.fetch = original;
    }
  });
});
