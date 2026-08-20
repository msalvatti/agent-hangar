/**
 * Unit tests for the turn event publisher.
 *
 * Layer: unit.
 * Goal: one transaction carrying the exact `XADD` argument list and the `EXPIRE` that bounds the
 * stream's life, the returned entry id, and a per-command failure surfaced as a rejection.
 * Mocks: the shared recording Redis double, standing in for ioredis' chainable commander.
 */
import { turnEventsStreamKey } from '@agent-hangar/core';
import type { AgentEvent } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import {
  createTurnEventPublisher,
  EVENT_STREAM_MAXLEN,
  EVENT_STREAM_TTL_SECONDS,
} from './events.js';
import { FakeRedisClient } from './testing/index.js';

const event: AgentEvent = { type: 'prepare.progress', message: 'Cloning…' };

describe('createTurnEventPublisher', () => {
  /**
   * The entry carries the discriminator and the whole event, capped and given a lifetime in one
   * transaction, and the publisher hands back the id the SSE route uses as its event id.
   */
  it('appends a capped entry with a lifetime and returns its id', async () => {
    const redis = new FakeRedisClient();

    const id = await createTurnEventPublisher(redis).publish('turn-1', event);

    const key = turnEventsStreamKey('turn-1');
    expect(id).toBe('1700000000000-0');
    expect(redis.xadds).toEqual([
      {
        key,
        args: ['MAXLEN', '~', String(EVENT_STREAM_MAXLEN), '*', 'event', JSON.stringify(event)],
      },
    ]);
    expect(redis.expiries).toEqual([[key, EVENT_STREAM_TTL_SECONDS]]);
  });

  /**
   * ioredis reports a failed command inside the tuple instead of rejecting; a publisher that read
   * only the result would treat a lost event as delivered.
   */
  it('rejects when the queued XADD failed', async () => {
    const redis = new FakeRedisClient({ execReplies: [[new Error('OOM'), null]] });

    await expect(createTurnEventPublisher(redis).publish('turn-1', event)).rejects.toThrow('OOM');
  });

  /**
   * An aborted transaction resolves with `null`; that is a lost event too, not a silent success.
   */
  it('rejects when the transaction was aborted', async () => {
    const redis = new FakeRedisClient({ execReplies: null });

    await expect(createTurnEventPublisher(redis).publish('turn-1', event)).rejects.toThrow(
      /no reply/,
    );
  });

  /**
   * A reply that is not a stream id cannot be handed to the browser as `Last-Event-ID`.
   */
  it('rejects when the reply carries no stream id', async () => {
    const redis = new FakeRedisClient({ execReplies: [[null, null]] });

    await expect(createTurnEventPublisher(redis).publish('turn-1', event)).rejects.toThrow(
      /no stream id/,
    );
  });
});
