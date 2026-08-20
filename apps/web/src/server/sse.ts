/**
 * Server-Sent Events over a Redis Stream: replay what was missed, then tail what arrives.
 *
 * Layer: service (server).
 *
 * The worker writes every agent event to `events:turn:<id>` and the browser reads it back through
 * this factory. Two properties make the transport survivable rather than merely working:
 *
 * 1. **Resumable.** Every frame carries the Redis entry id, which the browser echoes as
 *    `Last-Event-ID` when it reconnects. Replay is an exclusive `XRANGE` from that id, so a
 *    reconnect delivers what was missed and nothing the transcript already shows.
 * 2. **Bounded.** The tail read blocks on a *duplicated* connection, never on the shared one: a
 *    blocking command occupies its connection entirely, and the shared client serves every other
 *    request in the process. That connection is dropped on every exit path — terminal event,
 *    client abort, reader cancel, or an error — so a closed tab does not leave a blocked reader
 *    behind.
 *
 * Nothing is compressed or buffered: `no-transform` tells a proxy to leave the body alone, and
 * `X-Accel-Buffering: no` tells the one proxy that ignores it anyway.
 */
import { parseTurnEventEntry } from '@agent-hangar/core';
import type { SseFrame } from '@agent-hangar/core';
import type { Logger } from 'pino';

import { failureName } from './errors';
import type { RedisCommands, StreamEntry } from './redis';

/** Headers of every event stream. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** Events after which no more will ever arrive, so the stream closes itself. */
export const SSE_TERMINAL_EVENTS: readonly string[] = [
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
];

/** Event name telling the client the replay cache is gone and it should refetch the transcript. */
export const SSE_EXPIRED_EVENT = 'expired';

/** Comment frame that keeps the connection alive through an idle proxy. */
export const SSE_HEARTBEAT_FRAME = ': ping\n\n';

/** Cursor meaning "from the very beginning of the stream". */
export const SSE_STREAM_START = '0-0';

/** Frame emitted for a stream entry that does not decode to a valid event. */
const PROTOCOL_ERROR_FRAME = {
  event: 'protocol.error',
  data: JSON.stringify({ type: 'protocol.error', reason: 'schema-violation', length: 0 }),
} as const;

/** What {@link createSseResponse} needs in order to serve one stream. */
export interface SseSourceOptions {
  /** Shared command connection; the factory duplicates it for the blocking read. */
  redis: RedisCommands;
  /** Redis Stream carrying the events. */
  streamKey: string;
  /** Resume point from `Last-Event-ID` or `?from=`; absent means replay everything. */
  lastEventId?: string;
  /** Whether the turn or run has reached a terminal status. */
  isFinished: () => Promise<boolean>;
  /** Aborted when the client goes away. */
  signal: AbortSignal;
  /** Interval of the `: ping` comment. */
  heartbeatMs: number;
  /** How long each tail read blocks before the loop rechecks its exit conditions. */
  blockMs: number;
  logger: Logger;
}

/**
 * Serialises one frame in the wire format.
 *
 * The payload is JSON, which never contains a raw newline, so a frame can never be split by its
 * own data — the property the framing depends on.
 *
 * @param frame - Entry id, event name and JSON payload.
 * @returns The bytes of one frame, terminator included.
 */
export function formatSseFrame(frame: SseFrame): string {
  return `id: ${frame.id}\nevent: ${frame.event}\ndata: ${frame.data}\n\n`;
}

/**
 * Opens an event stream over a Redis Stream.
 *
 * @param options - Connection, stream key, resume point, liveness probe and timings.
 * @returns A `200 text/event-stream` response.
 */
export function createSseResponse(options: SseSourceOptions): Response {
  const encoder = new TextEncoder();
  const connection = options.redis.duplicate();
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;

  /**
   * Releases the heartbeat and the duplicated connection, once.
   *
   * @returns `true` when this call was the one that released them.
   */
  const release = (): boolean => {
    if (closed) {
      return false;
    }
    closed = true;
    clearInterval(heartbeat);
    connection.disconnect();
    return true;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      const write = (text: string): void => {
        // Enqueuing after the body closed throws, and the only writer left at that point is the
        // pump, whose catch already treats a failure after the close as the ordinary end.
        controller.enqueue(encoder.encode(text));
      };
      const stop = (): void => {
        if (release()) {
          controller.close();
        }
      };
      if (options.signal.aborted) {
        // The client gave up while the handler was still resolving which stream to read. The abort
        // event has already fired, so a listener would never see it.
        stop();
        return;
      }
      // `once: true` unregisters the listener when it fires, and the signal lives exactly as long
      // as the request, so a listener that never fires is collected with it. `stop` is idempotent,
      // which is what makes a late abort a no-op rather than a second close.
      options.signal.addEventListener('abort', stop, { once: true });
      heartbeat = setInterval(() => {
        write(SSE_HEARTBEAT_FRAME);
      }, options.heartbeatMs);
      void pump(options, connection, write, () => closed, stop);
    },
    cancel(): void {
      // The consumer went away without aborting the request, which is what `reader.cancel()` looks
      // like. The body is already closing, so only the held resources have to go.
      release();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/**
 * Emits one stream entry and reports whether it ended the stream.
 *
 * @param entry - Redis entry id and its flat field list.
 * @param write - Sink for the frame.
 * @returns `true` when the entry was a terminal event.
 */
function emit(entry: StreamEntry, write: (text: string) => void): boolean {
  const [id, fields] = entry;
  const event = parseTurnEventEntry(fields);
  if (event === null) {
    // The entry is data written by another process; one unreadable entry is reported and the
    // stream carries on rather than ending on someone else's mistake.
    write(formatSseFrame({ id, ...PROTOCOL_ERROR_FRAME }));
    return false;
  }
  write(formatSseFrame({ id, event: event.type, data: JSON.stringify(event) }));
  return SSE_TERMINAL_EVENTS.includes(event.type);
}

/**
 * Replays what the client missed, then tails the stream until it ends.
 *
 * @param options - The stream options.
 * @param connection - The duplicated connection this pump owns.
 * @param write - Sink for the frames.
 * @param isClosed - Whether the stream has already been closed.
 * @param stop - Closes the stream and releases the connection.
 */
async function pump(
  options: SseSourceOptions,
  connection: RedisCommands,
  write: (text: string) => void,
  isClosed: () => boolean,
  stop: () => void,
): Promise<void> {
  try {
    let cursor = options.lastEventId ?? SSE_STREAM_START;
    if ((await connection.exists(options.streamKey)) === 0 && (await options.isFinished())) {
      // The replay cache expired and the work is over, so there is nothing left to stream. The
      // client refetches the persisted transcript instead of waiting for frames that never come.
      write(formatSseFrame({ id: cursor, event: SSE_EXPIRED_EVENT, data: '{}' }));
      stop();
      return;
    }
    if (options.lastEventId !== undefined) {
      for (const entry of await connection.xrange(options.streamKey, `(${cursor}`, '+')) {
        cursor = entry[0];
        if (emit(entry, write)) {
          stop();
          return;
        }
      }
    }
    while (!isClosed()) {
      const reply = await connection.xread(
        'BLOCK',
        options.blockMs,
        'STREAMS',
        options.streamKey,
        cursor,
      );
      if (reply === null) {
        // Belt and braces: the work finished without a terminal event ever being written, which a
        // crashed worker produces. Everything up to the cursor was delivered, so the stream ends.
        if (cursor !== SSE_STREAM_START && (await options.isFinished())) {
          stop();
          return;
        }
        continue;
      }
      for (const [, entries] of reply) {
        for (const entry of entries) {
          cursor = entry[0];
          if (emit(entry, write)) {
            stop();
            return;
          }
        }
      }
    }
  } catch (error) {
    // A command rejecting because the connection was dropped is the ordinary way this loop ends,
    // so only a failure that arrives while the stream is still open is worth reporting.
    if (!isClosed()) {
      options.logger.warn(
        { failure: failureName(error), key: options.streamKey },
        'event stream failed',
      );
      stop();
    }
  }
}
