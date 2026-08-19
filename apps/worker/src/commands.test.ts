/**
 * Unit tests for the cancel command listener.
 *
 * Layer: unit.
 * Goal: two turns routed independently over one connection, both cancel spellings accepted,
 * anything else logged and ignored, a throwing handler contained, and unsubscribe both removing
 * the route and releasing the channel.
 * Mocks: a hand-built subscriber recording channels and replaying messages on demand.
 */
import { turnCommandChannel } from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import { CANCEL_PAYLOAD, createCommandListener, isCancelPayload } from './commands.js';
import type { CommandRedis } from './commands.js';
import { createTestContainer } from './testing/index.js';

/** A pub/sub connection a test drives by hand. */
class FakeSubscriber implements CommandRedis {
  readonly subscribed: string[] = [];
  readonly unsubscribed: string[] = [];
  private listener: ((channel: string, payload: string) => void) | undefined;

  on(_event: 'message', listener: (channel: string, payload: string) => void): unknown {
    this.listener = listener;
    return this;
  }

  subscribe(channel: string): Promise<unknown> {
    this.subscribed.push(channel);
    return Promise.resolve(1);
  }

  unsubscribe(channel: string): Promise<unknown> {
    this.unsubscribed.push(channel);
    return Promise.resolve(0);
  }

  /** Delivers a message as Redis would. */
  deliver(channel: string, payload: string): void {
    this.listener?.(channel, payload);
  }

  /** How many message listeners were installed; the shared connection must only ever get one. */
  get listenerCount(): number {
    return this.listener === undefined ? 0 : 1;
  }
}

/** Builds a listener over a fake subscriber and the test container's capturing logger. */
function setup(): {
  subscriber: FakeSubscriber;
  listener: ReturnType<typeof createCommandListener>;
  logs: string[];
} {
  const subscriber = new FakeSubscriber();
  const { logger, logs } = createTestContainer();
  return { subscriber, listener: createCommandListener(subscriber, logger), logs };
}

describe('isCancelPayload', () => {
  /**
   * Both spellings are accepted: the bare word an operator types and the JSON the API sends.
   */
  it('accepts the bare word and the JSON command', () => {
    expect(isCancelPayload(CANCEL_PAYLOAD)).toBe(true);
    expect(isCancelPayload(JSON.stringify({ type: 'cancel' }))).toBe(true);
  });

  /**
   * Anything else is not a command: a different type, a payload that is not JSON, and a JSON
   * value that is not an object all fall through without throwing.
   */
  it('rejects everything else without throwing', () => {
    expect(isCancelPayload(JSON.stringify({ type: 'pause' }))).toBe(false);
    expect(isCancelPayload('{not json')).toBe(false);
    expect(isCancelPayload('42')).toBe(false);
  });
});

describe('createCommandListener', () => {
  /**
   * One connection serves every concurrent turn, so a message must reach only the turn whose
   * channel it arrived on — and only one listener may ever be installed on the connection.
   */
  it('routes two turns independently over one connection', async () => {
    const { subscriber, listener } = setup();
    const first = vi.fn();
    const second = vi.fn();

    await listener.subscribe('turn-1', { onCancel: first });
    await listener.subscribe('turn-2', { onCancel: second });
    subscriber.deliver(turnCommandChannel('turn-2'), CANCEL_PAYLOAD);

    expect(subscriber.listenerCount).toBe(1);
    expect(subscriber.subscribed).toEqual([
      turnCommandChannel('turn-1'),
      turnCommandChannel('turn-2'),
    ]);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  /**
   * The JSON spelling reaches the same handler.
   */
  it('accepts the JSON command form', async () => {
    const { subscriber, listener } = setup();
    const onCancel = vi.fn();

    await listener.subscribe('turn-1', { onCancel });
    subscriber.deliver(turnCommandChannel('turn-1'), JSON.stringify({ type: 'cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  /**
   * An unrecognised payload is reported by channel only — the body is untrusted input and must
   * not be echoed — and no handler runs.
   */
  it('warns and ignores an unknown payload', async () => {
    const { subscriber, listener, logs } = setup();
    const onCancel = vi.fn();

    await listener.subscribe('turn-1', { onCancel });
    subscriber.deliver(turnCommandChannel('turn-1'), 'rm -rf /');

    expect(onCancel).not.toHaveBeenCalled();
    expect(logs.join('')).toContain('ignored unknown command');
    expect(logs.join('')).not.toContain('rm -rf');
  });

  /**
   * A message for a channel nobody subscribed to is dropped silently: the route is gone, and a
   * warning per stray message would be noise.
   */
  it('drops a message for an unknown channel', async () => {
    const { subscriber, listener, logs } = setup();
    await listener.subscribe('turn-1', { onCancel: vi.fn() });

    subscriber.deliver(turnCommandChannel('turn-9'), CANCEL_PAYLOAD);

    expect(logs.join('')).not.toContain('ignored unknown command');
  });

  /**
   * A handler that throws must not take the shared connection's listener down with it; every
   * other running turn depends on that one callback surviving.
   */
  it('contains a throwing handler', async () => {
    const { subscriber, listener, logs } = setup();
    await listener.subscribe('turn-1', {
      onCancel: () => {
        throw new Error('boom');
      },
    });

    expect(() => {
      subscriber.deliver(turnCommandChannel('turn-1'), CANCEL_PAYLOAD);
    }).not.toThrow();
    expect(logs.join('')).toContain('cancel handler failed');
  });

  /**
   * Unsubscribing both releases the channel on Redis and removes the route, so a message that
   * races the teardown reaches nothing.
   */
  it('removes the route and releases the channel on unsubscribe', async () => {
    const { subscriber, listener } = setup();
    const onCancel = vi.fn();
    const stop = await listener.subscribe('turn-1', { onCancel });

    await stop();
    subscriber.deliver(turnCommandChannel('turn-1'), CANCEL_PAYLOAD);

    expect(subscriber.unsubscribed).toEqual([turnCommandChannel('turn-1')]);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
