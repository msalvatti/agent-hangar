/**
 * Publication of turn events to the Redis Stream the SSE route reads.
 *
 * Layer: infrastructure.
 *
 * One stream per turn or job run, keyed by `turnEventsStreamKey`. Each entry is the flat field
 * list `['event', '<JSON AgentEvent>']`: the SSE route reads that one field back, derives the
 * `event:` line from the event's own `type` and writes the JSON as the `data:` line. The entry id
 * Redis hands back is what a browser replays from through `Last-Event-ID`.
 *
 * Security: every event handed to `publish` has already passed through the redactor. This module
 * neither redacts nor inspects — it must stay the boring last hop, so that "redact before publish"
 * has exactly one place it can be forgotten and that place is covered by tests.
 */
import {
  TURN_EVENT_FIELD,
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

/**
 * Name of the single stream field carrying one JSON-encoded event.
 *
 * The web app reads it back by this exact name, so the two must agree; it comes from the shared
 * queue contract and is re-exported rather than redefined.
 */
export { TURN_EVENT_FIELD };

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

/** What `EXPIRE` answers when it set the key's lifetime. */
const EXPIRE_APPLIED = 1;

/**
 * Reads both replies of a transaction, rejecting the driver's `[error, result]` tuples.
 *
 * ioredis reports a per-command failure inside the tuple instead of rejecting the transaction, so
 * a caller that only reads the result would treat a failed `XADD` as a successful publish — and a
 * caller that reads only the first tuple would report success for a transaction whose `EXPIRE`
 * failed, leaving a stream that outlives its retention with nothing recording that it does. Both
 * commands are therefore checked, the `EXPIRE` down to its result: a reply of zero means the key
 * was not there to be given a lifetime.
 *
 * @param replies - What `multi().exec()` resolved with; `null` when the transaction was aborted.
 * @returns The stream entry id.
 * @throws Error When the transaction was aborted, incomplete, or either command failed.
 */
function readStreamId(replies: [Error | null, unknown][] | null): string {
  const added = replies?.at(0);
  const expired = replies?.at(1);
  if (added === undefined || expired === undefined) {
    throw new Error('publishing a turn event returned no reply');
  }
  if (added[0] !== null) {
    throw added[0];
  }
  if (expired[0] !== null) {
    throw expired[0];
  }
  const id = added[1];
  if (typeof id !== 'string') {
    throw new Error('publishing a turn event returned no stream id');
  }
  if (expired[1] !== EXPIRE_APPLIED) {
    throw new Error('publishing a turn event set no lifetime on its stream');
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
          TURN_EVENT_FIELD,
          JSON.stringify(event),
        )
        .expire(key, EVENT_STREAM_TTL_SECONDS)
        .exec();
      return readStreamId(replies);
    },
  };
}
