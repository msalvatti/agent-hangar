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

/** A chat whose newest turn has finished, so there is nothing to follow. */
const IDLE: MappedChat = {
  items: [],
  phase: 'idle',
  activeTurnId: null,
  startedAt: null,
  lastPrompt: null,
};

/**
 * The same chat, opened after its turn succeeded. Held as one value rather than built inline: the
 * hook reseeds on every snapshot it has not already seeded from, so a fresh object per render is a
 * render loop of the test's own making.
 */
const FINISHED: MappedChat = { ...IDLE, phase: 'succeeded' };

/**
 * Drives the hook with the snapshot under the caller's control, so a test can hand it the next
 * persisted record the way a refetch would.
 *
 * @param initial - The snapshot to mount with.
 * @returns The hook view, the sources it opened and the refetch it was given.
 */
function renderControlled(initial: MappedChat): {
  result: { current: ReturnType<typeof useChatStream> };
  rerender: (props: { mapped: MappedChat }) => void;
  instances: FakeEventSource[];
  refetch: ReturnType<typeof vi.fn>;
} {
  const { factory, instances } = createFakeEventSourceFactory();
  const refetch = vi.fn().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(
    ({ mapped }: { mapped: MappedChat }) => useChatStream('chat-1', mapped, refetch, factory),
    { initialProps: { mapped: initial } },
  );
  return { result, rerender, instances, refetch };
}

/**
 * Settles every pending effect and microtask, so "nothing further happened" is a claim about a
 * quiet hook rather than about one that had not got there yet.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

/**
 * The one source the hook has open.
 *
 * @param instances - Sources the factory has created.
 * @param index - Which one to read.
 * @returns The source.
 */
function sourceAt(instances: FakeEventSource[], index: number): FakeEventSource {
  const source = instances[index];
  if (source === undefined) {
    throw new Error(`No EventSource was opened at index ${String(index)}`);
  }
  return source;
}

/**
 * Drives the hook alone and hands back its result, so a test can call `followTurn`.
 *
 * @returns The hook result and the sources it opened.
 */
function renderFollowable(): {
  result: { current: ReturnType<typeof useChatStream> };
  instances: FakeEventSource[];
} {
  const { factory, instances } = createFakeEventSourceFactory();
  const refetch = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() => useChatStream('chat-1', RUNNING, refetch, factory));
  return { result, instances };
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

  /**
   * And not before. The lists are refreshed because a turn *ended*; doing it while one is still
   * running turns every chat with an open turn into a standing refetch of both sidebar lists.
   */
  it('leaves the chat lists alone while the turn is still running', async () => {
    const { loader, instances } = renderStream();
    await waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(1);
    });
    act(() => {
      sourceAt(instances, 0).open();
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(loader).toHaveBeenCalledTimes(1);
  });

  /**
   * A chat opened after its turn had already finished has nothing to reconcile: the persisted
   * record it was rendered from is the same record the lists read, so refreshing them on mount
   * would refetch both lists for every finished chat the operator opens.
   */
  it('leaves the chat lists alone for a chat with no live turn', async () => {
    const loader = vi.fn().mockResolvedValue(null);
    const { factory } = createFakeEventSourceFactory();
    const refetch = vi.fn().mockResolvedValue(undefined);
    renderHook(() => {
      useApiQuery(['chats', 'ACTIVE'], (): Promise<null> => {
        loader();
        return Promise.resolve(null);
      });
      return useChatStream('chat-1', FINISHED, refetch, factory);
    });
    await waitFor(() => {
      expect(loader).toHaveBeenCalledTimes(1);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe('useChatStream.followTurn', () => {
  /**
   * A follow-up message queues a turn with a new id while the stream is still attached to the one
   * that just finished. The SSE route is per chat, so the url does not change and only an explicit
   * reopen moves the stream onto the new turn.
   */
  it('reopens the stream when a different turn is followed', async () => {
    const { result, instances } = renderFollowable();
    await waitFor(() => {
      expect(instances).toHaveLength(1);
    });

    act(() => {
      result.current.followTurn('turn-2');
    });

    await waitFor(() => {
      expect(instances).toHaveLength(2);
    });
    expect(result.current.activeTurnId).toBe('turn-2');
  });

  /**
   * Following the turn that is already followed changes nothing, which is exactly why a retry —
   * which re-runs the same turn row — has to ask for the reconnection itself.
   */
  it('does not reopen the stream when the same turn is followed again', async () => {
    const { result, instances } = renderFollowable();
    await waitFor(() => {
      expect(instances).toHaveLength(1);
    });

    act(() => {
      result.current.followTurn('turn-1');
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(instances).toHaveLength(1);
  });

  /**
   * The first turn of a chat needs no reopen: going from no turn to a turn flips the url away from
   * `null`, and that is what opens the connection. Asking for a reconnect as well would open a
   * second stream over the first and deliver every frame twice.
   */
  it('opens one stream when the chat gets its first turn', async () => {
    const { result, instances } = renderControlled(IDLE);
    await settle();
    expect(instances).toHaveLength(0);

    act(() => {
      result.current.followTurn('turn-1');
    });
    await settle();

    expect(instances).toHaveLength(1);
  });

  /**
   * And the turn ending needs none either. There is no turn left to follow, so a reconnect could
   * only report itself as reconnecting on a chat where nothing is going to arrive.
   */
  it('does not try to reconnect when the last turn finishes', async () => {
    const { result, rerender, instances } = renderControlled(RUNNING);
    await settle();
    act(() => {
      sourceAt(instances, 0).open();
    });
    expect(result.current.state.connection).toBe('open');

    rerender({ mapped: { ...RUNNING, phase: 'succeeded', activeTurnId: null } });
    await settle();

    expect(result.current.activeTurnId).toBeNull();
    expect(result.current.state.connection).toBe('open');
  });

  /**
   * A refetched snapshot moves the stream onto whatever turn that snapshot says is live — the chat
   * may have been asked something else in another tab, and the hook follows the record rather than
   * the turn it happened to mount on.
   */
  it('follows the turn of a reloaded snapshot', async () => {
    const { result, rerender } = renderControlled(RUNNING);
    await settle();

    rerender({ mapped: { ...RUNNING, activeTurnId: 'turn-2' } });
    await settle();

    expect(result.current.activeTurnId).toBe('turn-2');
  });

  /**
   * A render that hands back the snapshot the reducer was already seeded from is not new history.
   * Reseeding on it throws away every row the stream has delivered since — the answer being typed
   * out on screen disappears the moment anything above re-renders.
   */
  it('keeps what the stream delivered when the same snapshot comes back', async () => {
    const { result, rerender, instances } = renderControlled(RUNNING);
    await settle();
    act(() => {
      sourceAt(instances, 0).open();
      sourceAt(instances, 0).emit(
        'turn.completed',
        {
          type: 'turn.completed',
          usage: { inputTokens: 1, outputTokens: 1 },
          steps: 1,
          finalMessage: 'done',
        },
        '1-0',
      );
    });
    expect(result.current.state.phase).toBe('succeeded');

    rerender({ mapped: RUNNING });
    await settle();

    expect(result.current.state.phase).toBe('succeeded');
    expect(result.current.state.items).toHaveLength(1);
  });
});

describe('useChatStream expiry recovery', () => {
  /**
   * A stream the server can no longer serve is recovered from persistence, and the reopen waits for
   * that record to land: reconnecting first would ask for the same refused position again, and the
   * server cannot tell that request from the one it just declined.
   */
  it('reopens only once the reloaded chat has arrived', async () => {
    const { rerender, instances, refetch } = renderControlled(RUNNING);
    await settle();
    act(() => {
      sourceAt(instances, 0).open();
      sourceAt(instances, 0).emit('expired', { type: 'expired' });
    });
    await settle();

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(instances).toHaveLength(1);

    rerender({ mapped: { ...RUNNING } });
    await settle();

    expect(instances).toHaveLength(2);
  });

  /**
   * That reopen belongs to the reload it was waiting for and to no other. Left armed, the next
   * ordinary refetch — a rename, a list poll — would reopen the stream again and replay the whole
   * turn on top of itself.
   */
  it('does not reopen again on the next unrelated reload', async () => {
    const { rerender, instances } = renderControlled(RUNNING);
    await settle();
    act(() => {
      sourceAt(instances, 0).open();
      sourceAt(instances, 0).emit('expired', { type: 'expired' });
    });
    await settle();
    rerender({ mapped: { ...RUNNING } });
    await settle();
    expect(instances).toHaveLength(2);

    rerender({ mapped: { ...RUNNING } });
    await settle();

    expect(instances).toHaveLength(2);
  });

  /**
   * One refetch per expiry, not one per expiry event. The recovered stream can be refused again —
   * the window it asks for is gone for good — and a hook that reloaded on each refusal would sit in
   * a loop of full chat fetches for as long as the tab stays open.
   */
  it('does not reload the chat again for a second refusal of the same turn', async () => {
    const { rerender, instances, refetch } = renderControlled(RUNNING);
    await settle();
    act(() => {
      sourceAt(instances, 0).open();
      sourceAt(instances, 0).emit('expired', { type: 'expired' });
    });
    await settle();
    rerender({ mapped: { ...RUNNING } });
    await settle();

    act(() => {
      sourceAt(instances, 1).open();
      sourceAt(instances, 1).emit('expired', { type: 'expired' });
    });
    await settle();

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  /**
   * A new turn is a new stream, so it gets its own recovery: the refusal that ended the last turn
   * says nothing about this one, and a chat that hit an expiry once would otherwise never reload
   * again for the rest of the page's life.
   */
  it('recovers again once a new turn is followed', async () => {
    const { result, instances, refetch } = renderControlled(RUNNING);
    await settle();
    act(() => {
      sourceAt(instances, 0).open();
      sourceAt(instances, 0).emit('expired', { type: 'expired' });
    });
    await settle();
    expect(refetch).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.followTurn('turn-2');
    });
    await settle();
    act(() => {
      const latest = sourceAt(instances, instances.length - 1);
      latest.open();
      latest.emit('expired', { type: 'expired' });
    });
    await settle();

    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
