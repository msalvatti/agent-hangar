/**
 * Tests for the SSE transcript hook: connection lifecycle, event dispatch, malformed frames, the
 * stall watchdog, manual reconnect, and cleanup.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_EVENT_TYPES } from '../reducer';
import { createFakeEventSourceFactory } from '../testing/fake-event-source';

import type { UseTurnEventsOptions } from './useTurnEvents';
import { useTurnEvents } from './useTurnEvents';

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
