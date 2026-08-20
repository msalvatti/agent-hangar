/**
 * In-memory {@link RedisCommands} double: string keys, pub/sub recording and streams.
 *
 * Layer: test double.
 *
 * Streams are the reason this exists. The SSE endpoint replays with `XRANGE`, tails with a
 * blocking `XREAD` and must close its duplicated connection on abort, and driving all three
 * against a real server would make the unit suite depend on Redis. The double therefore models
 * exactly what the endpoint relies on: monotonic ids, an exclusive `(id` lower bound, a tail read
 * that resolves with `null` instead of blocking, and a `disconnect` that makes a later command
 * reject the way ioredis does.
 *
 * Every command body is synchronous and wrapped by {@link FakeRedis.guard}, which is what keeps a
 * closed connection a *rejection* rather than a throw: a caller awaiting the command must see the
 * same failure shape the real client produces.
 */
import type { RedisCommands, StreamEntry, StreamRead } from '../redis';

/** Message recorded by {@link FakeRedis.publish}. */
export interface PublishedMessage {
  channel: string;
  message: string;
}

/** Error message ioredis produces for a command issued after the connection was closed. */
export const CONNECTION_CLOSED_MESSAGE = 'Connection is closed.';

/** State shared by a client and every connection duplicated from it. */
interface SharedStore {
  keys: Map<string, string>;
  streams: Map<string, StreamEntry[]>;
  published: PublishedMessage[];
  sequence: { value: number };
}

/**
 * Creates the state a family of connections shares.
 *
 * @returns An empty store.
 */
function createStore(): SharedStore {
  return { keys: new Map(), streams: new Map(), published: [], sequence: { value: 0 } };
}

/** In-memory stand-in for the ioredis client. */
export class FakeRedis implements RedisCommands {
  /** Whether {@link FakeRedis.disconnect} has been called on this connection. */
  closed = false;

  /** Connections handed out by {@link FakeRedis.duplicate}, in creation order. */
  readonly duplicates: FakeRedis[] = [];

  private readonly store: SharedStore;

  /**
   * @param store - Shared state; omitted for a root connection.
   */
  constructor(store: SharedStore = createStore()) {
    this.store = store;
  }

  /** Messages published on this connection family, in order. */
  get published(): readonly PublishedMessage[] {
    return this.store.published;
  }

  /**
   * @returns `PONG`, as the real client does.
   */
  ping(): Promise<string> {
    return this.guard(() => 'PONG');
  }

  /**
   * @param key - Key to read.
   * @returns The stored value, or `null`.
   */
  get(key: string): Promise<string | null> {
    return this.guard(() => this.store.keys.get(key) ?? null);
  }

  /**
   * Writes a string key. The real command takes a TTL that this double ignores, because nothing
   * in the web process depends on expiry — only on the timestamp inside the value.
   *
   * @param key - Key to write.
   * @param value - Value to store.
   * @returns Resolves once stored.
   */
  set(key: string, value: string): Promise<void> {
    return this.guard(() => {
      this.store.keys.set(key, value);
    });
  }

  /**
   * @param key - Key to test.
   * @returns `1` when the key or stream exists, `0` otherwise.
   */
  exists(key: string): Promise<number> {
    return this.guard(() => (this.store.keys.has(key) || this.store.streams.has(key) ? 1 : 0));
  }

  /**
   * @param channel - Channel name.
   * @param message - Payload.
   * @returns The number of subscribers, always `0` here.
   */
  publish(channel: string, message: string): Promise<number> {
    return this.guard(() => {
      this.store.published.push({ channel, message });
      return 0;
    });
  }

  /**
   * Appends one entry to a stream.
   *
   * @param key - Stream key.
   * @param fields - Flat `[name, value, …]` field list.
   * @returns The generated entry id.
   */
  xadd(key: string, ...fields: string[]): Promise<string> {
    return this.guard(() => {
      this.store.sequence.value += 1;
      const id = `1-${String(this.store.sequence.value)}`;
      const entries = this.store.streams.get(key) ?? [];
      entries.push([id, fields]);
      this.store.streams.set(key, entries);
      return id;
    });
  }

  /**
   * @param key - Stream key.
   * @param start - `-`, an id, or `(id` for an exclusive lower bound.
   * @param end - `+` or an id.
   * @returns The matching entries, oldest first.
   */
  xrange(key: string, start: string, end: string): Promise<StreamEntry[]> {
    return this.guard(() => {
      const exclusive = start.startsWith('(');
      const lower = exclusive ? start.slice(1) : start;
      return (this.store.streams.get(key) ?? []).filter(([id]) => {
        const afterStart = lower === '-' || (exclusive ? id > lower : id >= lower);
        return afterStart && (end === '+' || id <= end);
      });
    });
  }

  /**
   * Non-blocking stand-in for the tail read: it answers immediately with whatever is already
   * there, and with `null` when nothing is, so a test drives the loop by appending entries.
   *
   * @param _blockToken - Ignored `BLOCK` literal.
   * @param _milliseconds - Ignored block duration.
   * @param _streamsToken - Ignored `STREAMS` literal.
   * @param key - Stream key.
   * @param id - Exclusive lower bound.
   * @returns One stream slice, or `null` when nothing follows `id`.
   */
  xread(
    _blockToken: 'BLOCK',
    _milliseconds: number,
    _streamsToken: 'STREAMS',
    key: string,
    id: string,
  ): Promise<StreamRead[] | null> {
    return this.guard(() => {
      const entries = (this.store.streams.get(key) ?? []).filter(([entryId]) => entryId > id);
      return entries.length === 0 ? null : [[key, entries]];
    });
  }

  /**
   * @returns A second connection over the same state, recorded in {@link FakeRedis.duplicates}.
   */
  duplicate(): FakeRedis {
    const copy = new FakeRedis(this.store);
    this.duplicates.push(copy);
    return copy;
  }

  /** Closes this connection; every later command rejects. */
  disconnect(): void {
    this.closed = true;
  }

  /**
   * Runs a command body, or rejects when the connection is closed.
   *
   * @param command - Synchronous body of the command.
   * @returns The command's result, as a promise.
   */
  private guard<T>(command: () => T): Promise<T> {
    return this.closed
      ? Promise.reject(new Error(CONNECTION_CLOSED_MESSAGE))
      : Promise.resolve(command());
  }
}
