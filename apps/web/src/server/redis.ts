/**
 * The Redis surface the web process uses, as a port.
 *
 * Layer: service (port).
 *
 * ioredis' `Redis` satisfies this interface structurally — the container assigns a real client to
 * it, which is the compile-time proof — while the SSE stream and the health probe can be driven by
 * an in-memory double. Only the commands actually issued are listed, so a command that appears in
 * a handler has to be added here on purpose.
 */

/** One Redis Stream entry: its id and its flat `[name, value, …]` field list. */
export type StreamEntry = [id: string, fields: string[]];

/** One stream's slice of an `XREAD` reply. */
export type StreamRead = [key: string, entries: StreamEntry[]];

/** Commands the web process issues. */
export interface RedisCommands {
  /** Round-trip probe used by `GET /api/health`. */
  ping(): Promise<string>;
  /** Reads a string key (the worker heartbeat). */
  get(key: string): Promise<string | null>;
  /** Whether a key exists; `1` when it does. */
  exists(key: string): Promise<number>;
  /** Publishes a command on a pub/sub channel (turn cancellation). */
  publish(channel: string, message: string): Promise<number>;
  /** Reads a bounded range of a stream; `start` may be `(id` for an exclusive lower bound. */
  xrange(key: string, start: string, end: string): Promise<StreamEntry[]>;
  /**
   * Blocking tail read.
   *
   * Only ever issued on a dedicated connection: a blocking command occupies the whole connection,
   * so running it on the shared client would stall every other request in the process.
   */
  xread(
    blockToken: 'BLOCK',
    milliseconds: number,
    streamsToken: 'STREAMS',
    key: string,
    id: string,
  ): Promise<StreamRead[] | null>;
  /** Opens a second connection with the same settings, for blocking reads. */
  duplicate(): RedisCommands;
  /** Closes the connection without waiting for in-flight replies. */
  disconnect(): void;
}
