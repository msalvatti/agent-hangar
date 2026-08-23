/**
 * Tests for the SSE transcript hook: connection lifecycle, event dispatch, malformed frames, the
 * stall watchdog, manual reconnect, and cleanup.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_EVENT_TYPES } from '../reducer';
import { createFakeEventSourceFactory } from '../testing/fake-event-source';

import type { UseTurnEventsOptions } from './useTurnEvents';
import { parseFrame, useTurnEvents } from './useTurnEvents';

function setup(overrides: Partial<UseTurnEventsOptions> = {}) {
  const { factory, instances } = createFakeEventSourceFactory();
  let currentTime = 0;
  const now = () => currentTime;
  const setNow = (value: number) => {
    currentTime = value;
  };
  const rendered = renderHook((props: UseTurnEventsOptions) => useTurnEvents(props), {
    initialProps: { url: '/api/chats/1/events', createEventSource: factory, now, ...overrides },
  });
  return { ...rendered, instances, setNow, factory };
}

describe('parseFrame', () => {
  /**
   * A well-formed frame is the event it carries.
   */
  it('reads a well-formed frame as its event', () => {
    expect(parseFrame(JSON.stringify({ type: 'step.started', step: 2 }))).toStrictEqual({
      type: 'step.started',
      step: 2,
    });
  });

  /**
   * The two ways a frame can be unusable are reported apart, with the length of the offending line
   * and nothing from it: a line that is not JSON is a transport or producer fault, and JSON of the
   * wrong shape is a protocol one. Reported under one name, a proxy truncating frames and a
   * runtime sending the wrong ones look identical.
   */
  it.each([
    ['not json at all', 'invalid-json'],
    ['{"type":"step.started"}', 'schema-violation'],
  ])('reports %s as a %s', (raw, reason) => {
    expect(parseFrame(raw)).toStrictEqual({
      type: 'protocol.error',
      reason,
      length: raw.length,
    });
  });
});

describe('useTurnEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The injected factory receives the url and the resume point.
  it('opens with the injected factory, passing url and lastEventId', () => {
    const { instances } = setup({ lastEventId: '3-0' });
    expect(instances).toHaveLength(1);
    expect(instances[0]?.url).toBe('/api/chats/1/events');
    expect(instances[0]?.lastEventId).toBe('3-0');
  });

  // With no lastEventId, the factory is called without a resume point.
  it('opens with no resume point when lastEventId is unset', () => {
    const { instances } = setup();
    expect(instances[0]?.lastEventId).toBeUndefined();
  });

  /**
   * A resume point seeds the state as well as the connection, so the first frame the server
   * replays — which is the one the client already saw — is recognised as a replay and dropped.
   * Seeded without it, the transcript applies that event twice.
   */
  it('seeds the state with the resume point it opens from', () => {
    const { result } = setup({ lastEventId: '3-0' });

    expect(result.current.state.lastEventId).toBe('3-0');
  });

  /**
   * And with no resume point the state starts from nothing rather than from a key seeded with
   * `null` under a name the reducer would compare against.
   */
  it('starts from nothing when there is no resume point', () => {
    const { result } = setup();

    expect(result.current.state.lastEventId).toBeNull();
    expect(result.current.state.items).toEqual([]);
    expect(result.current.state.phase).toBe('idle');
  });

  // initialItems and initialPhase seed the reducer, for resuming a chat already in progress.
  it('seeds the reducer from initialItems and initialPhase', () => {
    const { result } = setup({
      initialItems: [{ kind: 'user', id: 'u1', text: 'Hi' }],
      initialPhase: 'running',
    });
    expect(result.current.state.items).toEqual([{ kind: 'user', id: 'u1', text: 'Hi' }]);
    expect(result.current.state.phase).toBe('running');
  });

  // A frame with no lastEventId (the server's default channel) leaves lastEventId unchanged.
  it('leaves lastEventId unchanged when a frame carries no id', () => {
    const { result, instances } = setup();
    act(() => {
      instances[0]?.emit('step.started', { type: 'step.started', step: 1 });
    });
    expect(result.current.state.lastEventId).toBeNull();
    expect(result.current.state.step).toBe(1);
  });

  // onopen transitions the connection from connecting to open.
  it('transitions connecting -> open', () => {
    const { result, instances } = setup();
    expect(result.current.state.connection).toBe('connecting');
    act(() => {
      instances[0]?.open();
    });
    expect(result.current.state.connection).toBe('open');
  });

  // A listener is registered for every named AgentEvent type plus the synthetic "expired" frame.
  it('registers a listener for every AgentEvent type plus expired', () => {
    const { instances } = setup();
    const types = Array.from(instances[0]?.listeners.keys() ?? []);
    for (const type of AGENT_EVENT_TYPES) {
      expect(types).toContain(type);
    }
    expect(types).toContain('expired');
  });

  // A well-formed frame is parsed and folded into state via the reducer.
  it('dispatches a well-formed frame into state', () => {
    const { result, instances } = setup();
    act(() => {
      instances[0]?.emit('step.started', { type: 'step.started', step: 4 }, '1-0');
    });
    expect(result.current.state.step).toBe(4);
    expect(result.current.state.lastEventId).toBe('1-0');
  });

  // Invalid JSON never throws; it becomes a protocol.error notice.
  it('turns invalid JSON into a protocol.error notice instead of throwing', () => {
    const { result, instances } = setup();
    expect(() => {
      act(() => {
        instances[0]?.emit('step.started', 'not json', '1-0');
      });
    }).not.toThrow();
    expect(result.current.state.items).toEqual([
      { kind: 'notice', id: 'protocol-error-0', tone: 'warning', text: 'Malformed event skipped.' },
    ]);
    // The two ways a frame can be unusable are recorded separately: a line that is not JSON is a
    // transport or a producer fault, and JSON of the wrong shape is a protocol one. The reducer
    // counts them, and a single label would make the two indistinguishable in a report.
    expect(result.current.state.items).toHaveLength(1);
    act(() => {
      instances[0]?.emit('step.started', { type: 'step.started' }, '1-1');
    });
    expect(result.current.state.items).toHaveLength(2);
  });

  // A schema-violating payload (valid JSON, wrong shape) also becomes a protocol.error notice.
  it('turns a schema-violating payload into a protocol.error notice', () => {
    const { result, instances } = setup();
    act(() => {
      instances[0]?.emit('step.started', { type: 'step.started' }, '1-0');
    });
    expect(result.current.state.items).toEqual([
      { kind: 'notice', id: 'protocol-error-0', tone: 'warning', text: 'Malformed event skipped.' },
    ]);
  });

  // onerror while the browser is still retrying (CONNECTING) reads as "reconnecting".
  it('onerror with readyState CONNECTING sets connection to reconnecting', () => {
    const { result, instances } = setup();
    act(() => {
      instances[0]?.fail({ reconnecting: true });
    });
    expect(result.current.state.connection).toBe('reconnecting');
  });

  // onerror once retries are exhausted (CLOSED) reads as "closed".
  it('onerror with readyState CLOSED sets connection to closed', () => {
    const { result, instances } = setup();
    act(() => {
      instances[0]?.fail({ reconnecting: false });
    });
    expect(result.current.state.connection).toBe('closed');
  });

  // The server's "expired" frame closes the source and marks the connection expired.
  it('closes the source and sets connection to expired on the "expired" frame', () => {
    const { result, instances } = setup();
    act(() => {
      instances[0]?.emit('expired', {});
    });
    expect(instances[0]?.closeCount).toBe(1);
    expect(result.current.state.connection).toBe('expired');
  });

  // A terminal event (turn.completed here) both updates phase and closes the connection.
  it('closes the source on a terminal event', () => {
    const { result, instances } = setup();
    act(() => {
      instances[0]?.emit(
        'turn.completed',
        {
          type: 'turn.completed',
          usage: { inputTokens: 1, outputTokens: 1 },
          steps: 1,
          finalMessage: 'done',
        },
        '2-0',
      );
    });
    expect(result.current.state.phase).toBe('succeeded');
    expect(instances[0]?.closeCount).toBe(1);
    expect(result.current.state.connection).toBe('closed');
  });

  // While a turn is active and 45s pass with no activity, the watchdog reopens the connection.
  it('reopens the connection after a stall while the turn is active', () => {
    const { result, instances, setNow } = setup();
    act(() => {
      instances[0]?.emit('assistant.delta', { type: 'assistant.delta', text: 'hi' }, '1-0');
    });
    expect(result.current.state.phase).toBe('running');

    setNow(46_000);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(instances[0]?.closeCount).toBe(1);
    expect(instances).toHaveLength(2);
    expect(instances[1]?.lastEventId).toBe('1-0');
    expect(result.current.state.connection).toBe('reconnecting');
  });

  // A reopen itself grants a fresh stall grace period: without that, the next 5 s tick would see
  // the same stale `lastActivityAt` (no new data has arrived yet on the new connection) and
  // reopen again immediately, looping every 5 s instead of waiting a full 45 s per attempt.
  it('does not reopen again immediately after a stall-triggered reopen', () => {
    const { instances, setNow } = setup();
    act(() => {
      instances[0]?.emit('assistant.delta', { type: 'assistant.delta', text: 'hi' }, '1-0');
    });
    setNow(46_000);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(instances).toHaveLength(2);

    setNow(51_000);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(instances).toHaveLength(2);
  });

  // A resumed turn seeded as already "running" (e.g. a page reload mid-turn) has no recorded
  // activity yet; the watchdog must fall back to the connection's own open time instead of
  // treating a null lastActivityAt as "never stall".
  it('falls back to the connection open time when no activity has been recorded yet', () => {
    const { instances, setNow } = setup({ initialPhase: 'running' });
    setNow(46_000);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(instances).toHaveLength(2);
  });

  // While active but not yet stalled, the watchdog checks and does nothing.
  it('does not reopen the connection before the stall threshold is reached', () => {
    const { instances, setNow } = setup();
    act(() => {
      instances[0]?.emit('assistant.delta', { type: 'assistant.delta', text: 'hi' }, '1-0');
    });
    setNow(10_000);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(instances).toHaveLength(1);
  });

  /**
   * The stall is measured from the last sign of life, which is the later of the connection opening
   * and the last frame that arrived. Measured from the connection alone, a stream that has been
   * delivering frames all along is torn down and reopened forty-five seconds after it connected.
   */
  it('measures the stall from the last frame, not from the connection', () => {
    const { instances, setNow } = setup();
    setNow(30_000);
    act(() => {
      instances[0]?.emit('assistant.delta', { type: 'assistant.delta', text: 'hi' }, '1-0');
    });

    setNow(46_000);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(instances).toHaveLength(1);
  });

  /**
   * A turn that is still preparing its workspace is as active as one that is running: preparation
   * is the longest quiet stretch of a turn, and a watchdog that ignored it would leave a stream
   * that died during a clone hanging until the user reloads.
   */
  it('watches a turn that is still preparing', () => {
    const { instances, setNow } = setup({ initialPhase: 'preparing' });

    setNow(46_000);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(instances).toHaveLength(2);
  });

  /**
   * Every ending closes the stream. There is nothing more to deliver after one, and a connection
   * held open costs the browser a socket per finished turn on screen.
   */
  it.each([
    [{ type: 'turn.failed', error: { code: 'runtime_exit', message: 'gave up' } }, 'failed'],
    [{ type: 'turn.cancelled' }, 'cancelled'],
  ])('closes the stream on %o', (event, phase) => {
    const { result, instances } = setup();

    act(() => {
      instances[0]?.emit(event.type, event, '2-0');
    });

    expect(result.current.state.phase).toBe(phase);
    expect(instances[0]?.closeCount).toBe(1);
    expect(result.current.state.connection).toBe('closed');
  });

  /**
   * With no url there is nothing to connect to, so nothing is opened: a chat whose turn has not
   * been created yet renders before it has a stream, and dialling `null` is a request to the page
   * the app is served from.
   */
  it('opens nothing until there is a url', () => {
    const { result, instances } = setup({ url: null });

    expect(instances).toHaveLength(0);
    // And says nothing about a connection either: the badge reads this state, and one that
    // announced "connecting" with nothing to connect to would spin for a chat with no turn.
    expect(result.current.state.connection).toBe('idle');
  });

  /**
   * The clock is read afresh on every tick rather than captured when the hook first ran. A stall
   * is a comparison against now, and a watchdog holding a clock from an earlier render measures
   * against a time that stopped moving.
   */
  it('watches by the clock it currently has', () => {
    const { result, rerender, instances, factory } = setup();
    act(() => {
      instances[0]?.emit('assistant.delta', { type: 'assistant.delta', text: 'hi' }, '1-0');
    });
    expect(result.current.state.phase).toBe('running');

    rerender({
      url: '/api/chats/1/events',
      createEventSource: factory,
      now: () => 46_000,
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(result.current.state.connection).toBe('reconnecting');
  });

  /**
   * A manual reconnect says so while it reopens. The badge reads this state, and a reconnect that
   * left it saying "open" would show a connected stream for as long as the new one takes to
   * answer.
   */
  it('reports reconnecting while a manual reconnect reopens', () => {
    const { result, instances } = setup();

    act(() => {
      result.current.reconnect();
    });

    expect(result.current.state.connection).toBe('reconnecting');
    expect(instances).toHaveLength(2);
  });

  /**
   * The factory and the clock are read afresh on every reconnect rather than captured once: a
   * component that hands the hook a new factory — a test, or a page that rebuilds it — must have
   * that one used, or every later connection is opened by a factory nobody holds any more.
   */
  it('reconnects through the factory it currently has', () => {
    const { factory: second, instances: secondInstances } = createFakeEventSourceFactory();
    const { result, rerender, instances } = setup();

    rerender({
      url: '/api/chats/1/events',
      createEventSource: second,
      now: () => 0,
    });
    act(() => {
      result.current.reconnect();
    });

    expect(instances).toHaveLength(1);
    expect(secondInstances).toHaveLength(1);
  });

  // Exactly at the threshold is not yet a stall: the grace is what the connection is given, and
  // cutting it short at the boundary reopens a stream that was still inside its allowance.
  it('does not reopen at exactly the stall threshold', () => {
    const { instances, setNow } = setup();
    act(() => {
      instances[0]?.emit('assistant.delta', { type: 'assistant.delta', text: 'hi' }, '1-0');
    });

    setNow(45_000);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(instances).toHaveLength(1);
  });

  // The watchdog stops with the component. A timer left running reopens an EventSource for a page
  // nobody is looking at, every forty-five seconds, for as long as the tab is open.
  it('stops watching and closes the stream once unmounted', () => {
    const { instances, setNow, unmount } = setup();
    act(() => {
      instances[0]?.emit('assistant.delta', { type: 'assistant.delta', text: 'hi' }, '1-0');
    });

    unmount();
    setNow(46_000);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });

    expect(instances).toHaveLength(1);
    expect(instances[0]?.closeCount).toBe(1);
  });

  // Outside an active phase, the watchdog never reopens even after a long silence.
  it('does not reopen the connection while idle', () => {
    const { instances, setNow } = setup();
    setNow(200_000);
    act(() => {
      vi.advanceTimersByTime(200_000);
    });
    expect(instances).toHaveLength(1);
  });

  // reconnect() closes the current source and opens a fresh one from the last known event id.
  it('reconnect() closes the current source and reopens', () => {
    const { result, instances } = setup();
    act(() => {
      instances[0]?.emit('step.started', { type: 'step.started', step: 1 }, '1-0');
    });
    act(() => {
      result.current.reconnect();
    });
    expect(instances[0]?.closeCount).toBe(1);
    expect(instances).toHaveLength(2);
    expect(instances[1]?.lastEventId).toBe('1-0');
  });

  // Changing the url tears down the old connection and opens a new one.
  it('reopens and closes the previous source when url changes', () => {
    const { instances, rerender, factory } = setup();
    rerender({ url: '/api/chats/2/events', createEventSource: factory, now: () => 0 });
    expect(instances[0]?.closeCount).toBe(1);
    expect(instances).toHaveLength(2);
    expect(instances[1]?.url).toBe('/api/chats/2/events');
  });

  // Unmounting the hook closes its connection.
  it('closes the source on unmount', () => {
    const { instances, unmount } = setup();
    act(() => {
      unmount();
    });
    expect(instances[0]?.closeCount).toBe(1);
  });

  // `enabled: false` opens nothing.
  it('opens no connection when enabled is false', () => {
    const { instances } = setup({ enabled: false });
    expect(instances).toHaveLength(0);
  });

  // `url: null` opens nothing.
  it('opens no connection when url is null', () => {
    const { instances } = setup({ url: null });
    expect(instances).toHaveLength(0);
  });

  // Calling reconnect() while there is no url to connect to is a harmless no-op.
  it('reconnect() does nothing when url is null', () => {
    const { result, instances } = setup({ url: null });
    expect(() => {
      act(() => {
        result.current.reconnect();
      });
    }).not.toThrow();
    expect(instances).toHaveLength(0);
  });
});
