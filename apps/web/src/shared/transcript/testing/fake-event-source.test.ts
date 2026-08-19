/**
 * Tests for the `EventSource` test double itself: open/emit/fail/close and listener bookkeeping.
 */
import { describe, expect, it, vi } from 'vitest';

import { FakeEventSource, createFakeEventSourceFactory } from './fake-event-source';

describe('FakeEventSource', () => {
  // A fresh instance starts in the CONNECTING state and records its constructor arguments.
  it('starts CONNECTING and records url and lastEventId', () => {
    const source = new FakeEventSource('/api/chats/1/events', { lastEventId: '1-0' });
    expect(source.readyState).toBe(FakeEventSource.CONNECTING);
    expect(source.url).toBe('/api/chats/1/events');
    expect(source.lastEventId).toBe('1-0');
    expect(source.withCredentials).toBe(false);
  });

  // open() transitions to OPEN and invokes both onopen and any 'open' listeners.
  it('open() fires onopen and open listeners', () => {
    const source = new FakeEventSource('/x');
    const onopen = vi.fn();
    const listener = vi.fn();
    source.onopen = onopen;
    source.addEventListener('open', listener);
    source.open();
    expect(source.readyState).toBe(FakeEventSource.OPEN);
    expect(onopen).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // emit() delivers a MessageEvent to listeners of the named type, JSON-encoding object payloads.
  it('emit() delivers JSON-encoded object payloads to named listeners', () => {
    const source = new FakeEventSource('/x');
    const listener = vi.fn();
    source.addEventListener('turn.started', listener);
    source.emit(
      'turn.started',
      { type: 'turn.started', turnId: 't1', at: '2026-01-01T00:00:00Z' },
      '1-0',
    );
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]?.[0] as MessageEvent<string>;
    expect(event.data).toBe(
      JSON.stringify({ type: 'turn.started', turnId: 't1', at: '2026-01-01T00:00:00Z' }),
    );
    expect(event.lastEventId).toBe('1-0');
  });

  // emit() sends a raw string payload verbatim, so a test can script malformed JSON.
  it('emit() sends a raw string payload verbatim', () => {
    const source = new FakeEventSource('/x');
    const listener = vi.fn();
    source.addEventListener('turn.started', listener);
    source.emit('turn.started', 'not json');
    const event = listener.mock.calls[0]?.[0] as MessageEvent<string>;
    expect(event.data).toBe('not json');
    expect(event.lastEventId).toBe('');
  });

  // emit('message', ...) also invokes onmessage, matching the native EventSource default channel.
  it('emit("message", ...) invokes onmessage', () => {
    const source = new FakeEventSource('/x');
    const onmessage = vi.fn();
    source.onmessage = onmessage;
    source.emit('message', { hello: 'world' });
    expect(onmessage).toHaveBeenCalledTimes(1);
  });

  // fail({ reconnecting: true }) keeps the browser's own retry semantics (CONNECTING).
  it('fail({ reconnecting: true }) moves to CONNECTING and fires onerror', () => {
    const source = new FakeEventSource('/x');
    const onerror = vi.fn();
    const listener = vi.fn();
    source.onerror = onerror;
    source.addEventListener('error', listener);
    source.fail({ reconnecting: true });
    expect(source.readyState).toBe(FakeEventSource.CONNECTING);
    expect(onerror).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // fail({ reconnecting: false }) represents retries exhausted (CLOSED).
  it('fail({ reconnecting: false }) moves to CLOSED', () => {
    const source = new FakeEventSource('/x');
    source.fail({ reconnecting: false });
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });

  // close() moves to CLOSED and increments closeCount on every call.
  it('close() increments closeCount and moves to CLOSED', () => {
    const source = new FakeEventSource('/x');
    source.close();
    source.close();
    expect(source.closeCount).toBe(2);
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });

  // removeEventListener() stops further delivery to that listener.
  it('removeEventListener() stops delivery', () => {
    const source = new FakeEventSource('/x');
    const listener = vi.fn();
    source.addEventListener('heartbeat', listener);
    source.removeEventListener('heartbeat', listener);
    source.emit('heartbeat', { type: 'heartbeat', at: '2026-01-01T00:00:00Z' });
    expect(listener).not.toHaveBeenCalled();
  });

  // addEventListener/removeEventListener silently ignore a null listener (matches EventTarget).
  it('addEventListener/removeEventListener ignore a null listener', () => {
    const source = new FakeEventSource('/x');
    expect(() => {
      source.addEventListener('heartbeat', null);
      source.removeEventListener('heartbeat', null);
    }).not.toThrow();
  });

  // An EventListenerObject (an object with handleEvent) is supported, not only plain functions.
  it('accepts an EventListenerObject', () => {
    const source = new FakeEventSource('/x');
    const handleEvent = vi.fn();
    source.addEventListener('heartbeat', { handleEvent });
    source.emit('heartbeat', { type: 'heartbeat', at: '2026-01-01T00:00:00Z' });
    expect(handleEvent).toHaveBeenCalledTimes(1);
  });

  // removeEventListener also accepts an EventListenerObject, matching addEventListener's shape.
  it('removeEventListener accepts an EventListenerObject', () => {
    const source = new FakeEventSource('/x');
    const handleEvent = vi.fn();
    expect(() => {
      source.removeEventListener('heartbeat', { handleEvent });
    }).not.toThrow();
  });

  // dispatchEvent() with no registered listeners for the type is a no-op that still returns true.
  it('dispatchEvent() returns true even with no listeners', () => {
    const source = new FakeEventSource('/x');
    expect(source.dispatchEvent(new Event('unused'))).toBe(true);
  });
});

describe('createFakeEventSourceFactory', () => {
  // The factory records every instance it creates, in creation order.
  it('records created instances', () => {
    const { factory, instances } = createFakeEventSourceFactory();
    const a = factory('/a');
    const b = factory('/b', { lastEventId: '2-0' });
    expect(instances).toHaveLength(2);
    expect(instances[0]).toBe(a);
    expect(instances[1]).toBe(b);
  });
});
