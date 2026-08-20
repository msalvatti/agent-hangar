/**
 * Tests for `useSendMessage`: posting follow-ups and reporting what the API answered.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
