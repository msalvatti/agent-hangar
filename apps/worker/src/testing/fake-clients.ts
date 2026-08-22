/**
 * In-memory stand-ins for the two process-level clients the container owns.
 *
 * Layer: test double.
 *
 * They record rather than connect, so the wiring around them — how many connections are opened,
 * which commands the publisher issues, in which order everything is released — is asserted without
 * a Redis or a Postgres anywhere near the test.
 */
import type { ContainerDatabase, WorkerRedisClient } from '../container.js';
import type { EventStreamTransaction } from '../events.js';

/** One recorded `XADD`. */
export interface RecordedXadd {
  /** Stream key. */
  key: string;
  /** The remaining arguments, in raw wire order. */
  args: (string | number)[];
}

/** A Prisma stand-in that only has to be disconnectable. */
export class FakeDatabaseClient implements ContainerDatabase {
  /** How many times the pool was released. */
  disconnects = 0;

  /**
   * Records a release.
   *
   * @returns A resolved promise.
   */
  $disconnect(): Promise<void> {
    this.disconnects += 1;
    return Promise.resolve();
  }
}

/** Construction options of {@link FakeRedisClient}. */
export interface FakeRedisOptions {
  /** Name recorded on release, so a test can assert the order connections are closed in. */
  role?: string;
  /** Called with the role whenever this connection is closed. */
  onQuit?: (role: string) => void;
  /** Whether `quit` rejects, as a connection that is already gone does. */
  quitFails?: boolean;
  /** Replies `exec` resolves with; defaults to a successful `XADD` plus `EXPIRE`. */
  execReplies?: [Error | null, unknown][] | null;
}

/** A Redis stand-in covering the three roles the worker opens a connection for. */
export class FakeRedisClient implements WorkerRedisClient {
  /** Every `XADD` issued through a transaction. */
  readonly xadds: RecordedXadd[] = [];

  /** Every `EXPIRE` issued through a transaction. */
  readonly expiries: [string, number][] = [];

  /** Every `SET … EX` written, in order. */
  readonly writes: { key: string; value: string; mode: string; seconds: number }[] = [];

  /** Channels this connection subscribed to, in order. */
  readonly subscribed: string[] = [];

  /** Channels this connection unsubscribed from, in order. */
  readonly unsubscribed: string[] = [];

  /** Connections produced by `duplicate`, in order. */
  readonly duplicates: FakeRedisClient[] = [];

  /** How many times this connection was closed. */
  quits = 0;

  /** Name recorded on release. */
  readonly role: string;

  private readonly options: FakeRedisOptions;
  private listener: ((channel: string, payload: string) => void) | undefined;

  /**
   * @param options - Role, release callback, failure mode and scripted transaction replies.
   */
  constructor(options: FakeRedisOptions = {}) {
    this.options = options;
    this.role = options.role ?? 'redis';
  }

  /**
   * Opens a recording transaction.
   *
   * @returns A chainable recorder that resolves with the scripted replies.
   */
  multi(): EventStreamTransaction {
    const transaction: EventStreamTransaction = {
      xadd: (key, ...args) => {
        this.xadds.push({ key, args });
        return transaction;
      },
      expire: (key, seconds) => {
        this.expiries.push([key, seconds]);
        return transaction;
      },
      exec: () =>
        Promise.resolve(
          this.options.execReplies === undefined
            ? ([
                [null, '1700000000000-0'],
                [null, 1],
              ] as [Error | null, unknown][])
            : this.options.execReplies,
        ),
    };
    return transaction;
  }

  /**
   * Records a write with a lifetime.
   *
   * The mode is checked rather than ignored: Redis answers a `SET` whose option it does not
   * recognise with a syntax error, so a double that accepted anything would let a key be written
   * with no lifetime at all and still report success.
   *
   * @param key - Key written.
   * @param value - Value stored.
   * @param mode - Must be `EX`; anything else is what Redis refuses. Typed wider than the client
   *   interface declares, because what a caller actually sends is a string on the wire and this is
   *   the side that has to answer for it.
   * @param seconds - Lifetime.
   * @returns `OK`, as Redis reports.
   * @throws Error When the mode is not one Redis would accept.
   */
  set(key: string, value: string, mode: string, seconds: number): Promise<unknown> {
    if (mode !== 'EX') {
      return Promise.reject(new Error(`ERR syntax error near '${mode}'`));
    }
    this.writes.push({ key, value, mode, seconds });
    return Promise.resolve('OK');
  }

  /**
   * Installs the single message handler of a subscriber connection.
   *
   * @param _event - Always `message`.
   * @param listener - Handler to install.
   * @returns This connection.
   */
  on(_event: 'message', listener: (channel: string, payload: string) => void): unknown {
    this.listener = listener;
    return this;
  }

  /** How many message handlers were installed; a shared connection must only ever get one. */
  get listenerCount(): number {
    return this.listener === undefined ? 0 : 1;
  }

  /**
   * Records a subscription.
   *
   * @param channel - Channel to listen on.
   * @returns The number of channels, as Redis reports.
   */
  subscribe(channel: string): Promise<unknown> {
    this.subscribed.push(channel);
    return Promise.resolve(this.subscribed.length);
  }

  /**
   * Records an unsubscription.
   *
   * @param channel - Channel to stop listening on.
   * @returns The number of channels left.
   */
  unsubscribe(channel: string): Promise<unknown> {
    this.unsubscribed.push(channel);
    return Promise.resolve(0);
  }

  /**
   * Opens a second connection with the same options, as pub/sub requires.
   *
   * @returns The duplicate, also recorded on this connection.
   */
  duplicate(): FakeRedisClient {
    const copy = new FakeRedisClient({
      ...this.options,
      role: `${this.role}:duplicate`,
      quitFails: false,
    });
    this.duplicates.push(copy);
    return copy;
  }

  /**
   * Records a close.
   *
   * @returns `OK`, or a rejection when this connection was built to fail on close.
   */
  quit(): Promise<unknown> {
    this.quits += 1;
    this.options.onQuit?.(this.role);
    if (this.options.quitFails === true) {
      return Promise.reject(new Error('connection is already gone'));
    }
    return Promise.resolve('OK');
  }

  /**
   * Delivers a message as Redis would.
   *
   * @param channel - Channel the message arrived on.
   * @param payload - Raw message body.
   */
  deliver(channel: string, payload: string): void {
    this.listener?.(channel, payload);
  }
}
