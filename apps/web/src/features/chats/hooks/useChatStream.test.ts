/**
 * Tests for `useChatStream`: what the hook reconciles between the persisted chat, the stream and
 * the queries that render the same chat elsewhere.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useApiQuery } from '@/shared/api/use-api-query';
import { createFakeEventSourceFactory } from '@/shared/transcript/testing/fake-event-source';
import type { FakeEventSource } from '@/shared/transcript/testing/fake-event-source';

import type { MappedChat } from '../lib/map-chat-detail';

import { useChatStream } from './useChatStream';

/** A chat whose newest turn is still running, so the hook opens a stream for it. */
const RUNNING: MappedChat = {
  items: [],
  phase: 'running',
  activeTurnId: 'turn-1',
  startedAt: 0,
  lastPrompt: 'Fix the flaky test',
};

/**
 * Drives the hook with a scripted stream, alongside a query registered under the `chats` key.
 *
 * @returns The list loader spy and the sources the hook opened.
 */
function renderStream(): { loader: ReturnType<typeof vi.fn>; instances: FakeEventSource[] } {
  const loader = vi.fn().mockResolvedValue({ chats: [] });
  const { factory, instances } = createFakeEventSourceFactory();
  const refetch = vi.fn().mockResolvedValue(undefined);
  renderHook(() => {
    useApiQuery(['chats', 'ACTIVE'], (): Promise<null> => {
      loader();
      return Promise.resolve(null);
    });
    return useChatStream('chat-1', RUNNING, refetch, factory);
  });
  return { loader, instances };
}

describe('useChatStream', () => {
  // The chat lists render each row's dot from the persisted last-turn status, which no terminal
  // stream event updates on its own — so a finished turn would keep its running dot forever.
  it.each([
    [
      'turn.completed',
      {
        type: 'turn.completed',
        usage: { inputTokens: 1, outputTokens: 1 },
        steps: 1,
        finalMessage: 'done',
      },
    ],
    ['turn.failed', { type: 'turn.failed', error: { code: 'network', message: 'unreachable' } }],
    ['turn.cancelled', { type: 'turn.cancelled' }],
  ])('invalidates the chat lists on %s', async (type, payload) => {
    const { loader, instances } = renderStream();
    await waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(1);
    });
    const source = instances[0];
    if (source === undefined) {
      throw new Error('No EventSource was opened');
    }

    act(() => {
      source.open();
      source.emit(type, payload, '1-0');
    });
    await waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(2);
    });
  });

  // The invalidation happens once per turn: a second terminal event for the turn already
  // reconciled must not start another round of list refetches.
  it('invalidates the chat lists only once per turn', async () => {
    const { loader, instances } = renderStream();
    await waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(1);
    });
    const source = instances[0];
    if (source === undefined) {
      throw new Error('No EventSource was opened');
    }

    act(() => {
      source.open();
      source.emit('turn.cancelled', { type: 'turn.cancelled' }, '1-0');
    });
    await waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(2);
    });
    act(() => {
      source.emit(
        'turn.failed',
        { type: 'turn.failed', error: { code: 'network', message: 'unreachable' } },
        '2-0',
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
