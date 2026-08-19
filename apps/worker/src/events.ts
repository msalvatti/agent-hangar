/**
 * Publication of turn events to the Redis Stream the SSE route reads.
 *
 * Layer: infrastructure.
 *
 * One stream per turn or job run, keyed by `turnEventsStreamKey`. Each entry carries two fields:
 * `type`, the `AgentEvent` discriminator, which the SSE route maps to the `event:` line, and
 * `data`, the whole event as JSON, which becomes the `data:` line. The entry id BullMQ hands back
 * is what a browser replays from through `Last-Event-ID`.
 *
 * Security: every event handed to `publish` has already passed through the redactor. This module
 * neither redacts nor inspects — it must stay the boring last hop, so that "redact before publish"
 * has exactly one place it can be forgotten and that place is covered by tests.
 */
import {
  TURN_EVENTS_MAXLEN,
  TURN_EVENTS_TTL_SECONDS,
  turnEventsStreamKey,
} from '@agent-hangar/core';
import type { AgentEvent } from '@agent-hangar/core';

/**
 * Approximate cap on entries kept per stream.
 *
 * Mirrors the queue contract so the value the worker writes and the value the web app documents
 * cannot drift; it is re-exported rather than redefined.
 */
export const EVENT_STREAM_MAXLEN = TURN_EVENTS_MAXLEN;

/** Lifetime of a turn's stream, after which the UI falls back to the persisted transcript. */
export const EVENT_STREAM_TTL_SECONDS = TURN_EVENTS_TTL_SECONDS;

/** Stream field holding the event discriminator. */
export const EVENT_FIELD_TYPE = 'type';

/** Stream field holding the whole event as JSON. */
export const EVENT_FIELD_DATA = 'data';

/**
 * The transaction builder the publisher drives; ioredis' `ChainableCommander` satisfies it.
 *
 * Declared structurally rather than as the driver's own type so this module — and every test of
 * it — depends on the two commands it issues instead of on the several hundred ioredis exposes.
 */
export interface EventStreamTransaction {
  /**
   * Appends an entry.
   *
   * @param key - Stream key.
   * @param args - The remaining `XADD` arguments, in raw wire order.
   */
  xadd(key: string, ...args: (string | number)[]): EventStreamTransaction;
  /** Sets the key's lifetime in seconds. */
  expire(key: string, seconds: number): EventStreamTransaction;
  /** Runs the queued commands, resolving one `[error, result]` tuple per command. */
  exec(): Promise<[Error | null, unknown][] | null>;
}

/** The Redis surface {@link createTurnEventPublisher} needs; ioredis' `Redis` satisfies it. */
export interface EventStreamRedis {
  /**
   * Opens a transaction.
   *
   * The optional argument is part of the shape only because ioredis declares it: without it the
   * driver's overload set does not match this signature and the real client stops satisfying the
   * interface. Callers here pass nothing.
   *
   * @param commands - Commands to queue up front; unused by this application.
   */
  multi(commands?: unknown[][]): EventStreamTransaction;
}

/** Publishes the events of one turn so the SSE route can stream and replay them. */
export interface TurnEventPublisher {
  /**
   * Appends one event to a turn's stream.
   *
   * @param turnId - `Turn.id` or `JobRun.id`.
   * @param event - An already-redacted event.
   * @returns The Redis Stream entry id, which is the SSE event id.
   */
  publish(turnId: string, event: AgentEvent): Promise<string>;
}

/**
 * Reads the single reply of a transaction, rejecting the driver's `[error, result]` tuple.
 *
 * ioredis reports a per-command failure inside the tuple instead of rejecting the transaction, so
 * a caller that only reads the result would treat a failed `XADD` as a successful publish.
 *
 * @param replies - What `multi().exec()` resolved with; `null` when the transaction was aborted.
 * @returns The stream entry id.
 * @throws Error When the transaction was aborted or `XADD` failed.
 */
function readStreamId(replies: [Error | null, unknown][] | null): string {
  const first = replies?.[0];
  if (first === undefined) {
    throw new Error('publishing a turn event returned no reply');
  }
  const [failure, id] = first;
  if (failure !== null) {
    throw failure;
  }
  if (typeof id !== 'string') {
    throw new Error('publishing a turn event returned no stream id');
  }
  return id;
}

/**
 * Builds the publisher over a Redis connection.
 *
 * The `XADD` and the `EXPIRE` travel as one transaction so a stream can never be created without
 * its lifetime: a crash between the two would otherwise leave entries in Redis forever.
 *
 * @param redis - Producer connection (never the blocking worker connection).
 * @returns A publisher writing to the turn event streams.
 */
export function createTurnEventPublisher(redis: EventStreamRedis): TurnEventPublisher {
  return {
    async publish(turnId: string, event: AgentEvent): Promise<string> {
      const key = turnEventsStreamKey(turnId);
      const replies = await redis
        .multi()
        .xadd(
          key,
          'MAXLEN',
          '~',
          String(EVENT_STREAM_MAXLEN),
          '*',
          EVENT_FIELD_TYPE,
          event.type,
          EVENT_FIELD_DATA,
          JSON.stringify(event),
        )
        .expire(key, EVENT_STREAM_TTL_SECONDS)
        .exec();
      return readStreamId(replies);
    },
  };
}
