/**
 * Unit tests for the turn event publisher.
 *
 * Layer: unit.
 * Goal: one transaction carrying the exact `XADD` argument list and the `EXPIRE` that bounds the
 * stream's life, the returned entry id, and every way either command can fail surfaced as a
 * rejection rather than as a publish that quietly kept no retention.
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
    const redis = new FakeRedisClient({
      execReplies: [
        [new Error('OOM'), null],
        [null, 1],
      ],
    });

    await expect(createTurnEventPublisher(redis).publish('turn-1', event)).rejects.toThrow('OOM');
  });

  /**
   * A transaction can succeed on the append and fail on the lifetime. Reporting that as a
   * successful publish would leave a stream nothing ever expires, which is the retention guarantee
   * this module exists to keep.
   */
  it('rejects when the queued EXPIRE failed', async () => {
    const redis = new FakeRedisClient({
      execReplies: [
        [null, '1700000000000-0'],
        [new Error('EXPIRE refused'), null],
      ],
    });

    await expect(createTurnEventPublisher(redis).publish('turn-1', event)).rejects.toThrow(
      'EXPIRE refused',
    );
  });

  /**
   * `EXPIRE` answers zero when there was no key to give a lifetime to. The command did not fail,
   * but the stream is unbounded all the same, so it is not a publish this module reports as done.
   */
  it('rejects when EXPIRE set no lifetime', async () => {
    const redis = new FakeRedisClient({
      execReplies: [
        [null, '1700000000000-0'],
        [null, 0],
      ],
    });

    await expect(createTurnEventPublisher(redis).publish('turn-1', event)).rejects.toThrow(
      /no lifetime/,
    );
  });

  /**
   * Two commands were queued, so a reply carrying one of them says nothing about the other; the
   * lifetime is unaccounted for and the publish is not reported as successful.
   */
  it('rejects when the transaction answered for only one command', async () => {
    const redis = new FakeRedisClient({ execReplies: [[null, '1700000000000-0']] });

    await expect(createTurnEventPublisher(redis).publish('turn-1', event)).rejects.toThrow(
      /no reply/,
    );
  });

  /**
   * Each slot of the reply is accounted for on its own. The array is wire data from a driver, and
   * a reply whose first tuple is missing while the second is there is as unusable as one that is
   * short: the entry id would be read off nothing, and the caller would be handed a stream
   * position for an event that may never have been appended.
   */
  it('rejects when the reply is missing the entry it answered first', async () => {
    const redis = new FakeRedisClient({
      execReplies: [undefined as unknown as [Error | null, unknown], [null, 1]],
    });

    await expect(createTurnEventPublisher(redis).publish('turn-1', event)).rejects.toThrow(
      /no reply/,
    );
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
    const redis = new FakeRedisClient({
      execReplies: [
        [null, null],
        [null, 1],
      ],
    });

    await expect(createTurnEventPublisher(redis).publish('turn-1', event)).rejects.toThrow(
      /no stream id/,
    );
  });
});
