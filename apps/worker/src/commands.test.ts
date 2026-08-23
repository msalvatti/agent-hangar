/**
 * Unit tests for the cancel command listener.
 *
 * Layer: unit.
 * Goal: two turns routed independently over one connection, both cancel spellings accepted,
 * anything else logged and ignored, a throwing handler contained, and unsubscribe both removing
 * the route and releasing the channel.
 * Mocks: the shared recording Redis double, which records channels and replays messages on demand.
 */
import { turnCommandChannel } from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import { CANCEL_PAYLOAD, createCommandListener, isCancelPayload } from './commands.js';
import { createTestContainer, FakeRedisClient } from './testing/index.js';

/** Builds a listener over a fake subscriber and the test container's capturing logger. */
function setup(): {
  subscriber: FakeRedisClient;
  listener: ReturnType<typeof createCommandListener>;
  logs: string[];
} {
  const subscriber = new FakeRedisClient();
  const { logger, logs } = createTestContainer();
  return { subscriber, listener: createCommandListener(subscriber, logger), logs };
}

describe('isCancelPayload', () => {
  /**
   * Both spellings are accepted: the bare word an operator types and the JSON the API sends.
   */
  it('accepts the bare word and the JSON command', () => {
    // The bare word is written out: the web app publishes it and this worker reads it, so the two
    // sides agree on a literal rather than on a constant either of them could change alone.
    expect(isCancelPayload('cancel')).toBe(true);
    expect(CANCEL_PAYLOAD).toBe('cancel');
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
    // The channel is on the line. One connection carries every running turn, so a warning that
    // does not say which channel the stray payload arrived on names no turn at all — and the
    // payload itself is never echoed, because a command channel is reachable by anything holding
    // the Redis URL.
    expect(JSON.parse(logs.at(-1) ?? '{}')).toMatchObject({
      msg: 'ignored unknown command',
      channel: turnCommandChannel('turn-1'),
    });
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

    // Nothing at all is written, and nothing is called. A dispatch that carried on past the
    // missing route would reach for a handler that is not there on every stray message.
    expect(logs).toHaveLength(0);
  });

  /**
   * The handler is installed once, on the event that carries published payloads. This connection
   * is shared by every running turn: a listener added per subscription would call each turn's
   * cancel once per turn now subscribed, and a listener installed under a name Redis never emits
   * would leave every cancellation unheard.
   */
  it('installs one handler, for published messages', async () => {
    const { subscriber, listener } = setup();
    const first = vi.fn();
    const second = vi.fn();

    await listener.subscribe('turn-1', { onCancel: first });
    await listener.subscribe('turn-2', { onCancel: second });

    expect(subscriber.listenerCount).toBe(1);

    subscriber.deliver(turnCommandChannel('turn-2'), CANCEL_PAYLOAD);
    expect(second).toHaveBeenCalledTimes(1);
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
    // Which turn, and what it threw: a line saying only that a handler failed leaves an operator
    // with one connection, many turns and nothing to look at.
    expect(JSON.parse(logs.at(-1) ?? '{}')).toMatchObject({
      msg: 'cancel handler failed',
      channel: turnCommandChannel('turn-1'),
      err: expect.objectContaining({ message: 'boom' }) as unknown,
    });
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
