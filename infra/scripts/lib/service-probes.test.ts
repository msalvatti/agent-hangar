/**
 * Unit tests for the Postgres/Redis service probes.
 *
 * Layer: unit.
 * Goal: each probe reports success only when the service answered its own question — `SELECT 1`
 * for the database, `PONG` for the cache — and reports failure for a socket that accepts the
 * connection and answers nothing, which is the case a bare TCP check reported as healthy. Also:
 * a wrong reply, a rejected call, a probe that hangs past the deadline, and a client whose
 * teardown fails, none of which may turn a verdict into a thrown error.
 * Mocks: injected fakes for the shape-level cases; a real `node:net` listener plus the real
 * ioredis and Prisma/pg clients for the case the defect was found in.
 */
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../../packages/core/src/config/schema.js';
import {
  assertDatabaseReachable,
  createPrismaClient,
  disconnectPrisma,
} from '../../../packages/core/src/persistence/client.js';
import { createQueueConnection } from '../../../packages/core/src/queues/queues.js';

import {
  POSTGRES_FAILURE,
  PROBE_OK,
  REDIS_FAILURE,
  REDIS_PONG,
  probeServices,
} from './service-probes.js';
import type { ProbeRedisClient, ServiceProbesDeps } from './service-probes.js';

/** Short enough to keep the suite fast, long enough that a local answer always arrives first. */
const TEST_TIMEOUT_MS = 400;

/** Wait for the deadline-driven cases, comfortably above {@link TEST_TIMEOUT_MS}. */
const CASE_TIMEOUT_MS = 10_000;

const servers: Server[] = [];
const accepted: Socket[] = [];

afterEach(async () => {
  // A probe against a silent listener deliberately leaves its socket open, and `close` waits for
  // every connection to end; the accepted sockets are destroyed first so teardown does not wait
  // on the very state the test set up.
  for (const socket of accepted.splice(0)) {
    socket.destroy();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/**
 * Binds a loopback listener that accepts connections and never writes a byte — the unrelated
 * process squatting on an instance port.
 *
 * @returns The port it listens on.
 */
async function silentListener(): Promise<number> {
  const server = createServer((socket) => {
    accepted.push(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

/** A Redis stand-in whose reply and failure mode a test dictates. */
interface FakeRedis extends ProbeRedisClient {
  /** Whether {@link ProbeRedisClient.disconnect} was called. */
  disconnected: () => boolean;
  /**
   * Delivers an `error` event, as ioredis does while retrying.
   *
   * @returns `true` when something was listening for it.
   */
  emitError: () => boolean;
}

/**
 * Builds a Redis stand-in around one canned `ping` outcome.
 *
 * Listeners are kept per event name, as a real emitter keeps them: a double that called back
 * whatever name it was given would report the probe as absorbing `error` events while it had in
 * fact subscribed to an event ioredis never emits — which is the case where the unlistened `error`
 * takes the whole diagnostic down.
 *
 * @param ping - What `ping()` returns or rejects with.
 * @returns The client plus the observations a test asserts on.
 */
function fakeRedis(ping: () => Promise<string>): FakeRedis {
  let closed = false;
  const listeners = new Map<string, () => void>();
  return {
    on: (event, registered) => {
      listeners.set(event, registered);
      return undefined;
    },
    ping,
    disconnect: () => {
      closed = true;
    },
    disconnected: () => closed,
    emitError: () => {
      const listener = listeners.get('error');
      listener?.();
      return listener !== undefined;
    },
  };
}

/** Collaborators every fake-driven case starts from; each test overrides what it is about. */
function baseDeps(overrides: Partial<ServiceProbesDeps<object>> = {}): ServiceProbesDeps<object> {
  return {
    env: {},
    loadConfig: () => ({
      DATABASE_URL: 'postgresql://ah:ah@127.0.0.1:5432/agent_hangar_default',
      REDIS_URL: 'redis://127.0.0.1:6379',
    }),
    createDatabaseClient: () => ({}),
    assertDatabaseReachable: () => Promise.resolve(),
    disconnectDatabase: () => Promise.resolve(),
    createRedisClient: () => fakeRedis(() => Promise.resolve(REDIS_PONG)),
    timeoutMs: TEST_TIMEOUT_MS,
    ...overrides,
  };
}

describe('probeServices', () => {
  /**
   * Both services answer: two `ok` lines, in the documented order.
   */
  it('reports ok for a database and a cache that answer', async () => {
    await expect(probeServices(baseDeps())).resolves.toEqual([
      `POSTGRES=${PROBE_OK}`,
      `REDIS=${PROBE_OK}`,
    ]);
  });

  /**
   * The database is judged by the query, so a client that rejects it fails the probe.
   */
  it('reports the database failure when SELECT 1 rejects', async () => {
    const lines = await probeServices(
      baseDeps({
        assertDatabaseReachable: () => Promise.reject(new Error('unreachable')),
      }),
    );
    expect(lines).toEqual([`POSTGRES=${POSTGRES_FAILURE}`, `REDIS=${PROBE_OK}`]);
  });

  /**
   * A verdict is already decided by the time the client is closed, so a teardown that fails must
   * not replace a reported failure with a thrown one.
   */
  it('still reports its verdict when closing the database client fails', async () => {
    const lines = await probeServices(
      baseDeps({
        disconnectDatabase: () => Promise.reject(new Error('pool already gone')),
      }),
    );
    expect(lines).toEqual([`POSTGRES=${PROBE_OK}`, `REDIS=${PROBE_OK}`]);
  });

  /**
   * The cache is judged by the reply, not by the call completing: anything other than `PONG` is a
   * process that is not the cache this instance expects.
   */
  it('reports the cache failure when PING is answered with something else', async () => {
    const lines = await probeServices(
      baseDeps({ createRedisClient: () => fakeRedis(() => Promise.resolve('HTTP/1.1 400')) }),
    );
    expect(lines).toEqual([`POSTGRES=${PROBE_OK}`, `REDIS=${REDIS_FAILURE}`]);
  });

  /**
   * A rejected `ping` is a failure, and the client is closed either way — a probe that left
   * ioredis reconnecting would keep the diagnostic process alive after its table was printed.
   */
  it('reports the cache failure when PING rejects, and closes the client', async () => {
    const client = fakeRedis(() => Promise.reject(new Error('connection refused')));
    const lines = await probeServices(baseDeps({ createRedisClient: () => client }));
    expect(lines).toEqual([`POSTGRES=${PROBE_OK}`, `REDIS=${REDIS_FAILURE}`]);
    expect(client.disconnected()).toBe(true);
  });

  /**
   * ioredis emits `error` while it retries an unreachable endpoint. The probe registers a sink for
   * those events, because an EventEmitter with no `error` listener throws out of the process and
   * would abort the whole diagnostic instead of failing one row.
   */
  it('absorbs the error events the client emits while retrying', async () => {
    const client = fakeRedis(() => Promise.resolve(REDIS_PONG));
    const promise = probeServices(baseDeps({ createRedisClient: () => client }));

    // Something was listening for `error` in particular. A sink registered under any other name
    // absorbs nothing: ioredis emits `error`, and an emitter with no listener for it throws out of
    // the process, which ends the diagnostic instead of failing one row of it.
    expect(client.emitError()).toBe(true);

    await expect(promise).resolves.toEqual([`POSTGRES=${PROBE_OK}`, `REDIS=${PROBE_OK}`]);
  });

  /**
   * The words each verdict is reported in, written out. `doctor.sh` prints them into its table and
   * an operator reads them; `PONG` is the cache's own reply, so a probe comparing against anything
   * else calls a healthy cache unhealthy.
   */
  it('reports each verdict in the words the table prints', async () => {
    const healthy = await probeServices(
      baseDeps({ createRedisClient: () => fakeRedis(() => Promise.resolve('PONG')) }),
    );
    expect(healthy).toEqual(['POSTGRES=ok', 'REDIS=ok']);

    const unhealthy = await probeServices(
      baseDeps({
        assertDatabaseReachable: () => Promise.reject(new Error('unreachable')),
        createRedisClient: () => fakeRedis(() => Promise.resolve('nope')),
      }),
    );
    expect(unhealthy).toEqual(['POSTGRES=no-select-1', 'REDIS=no-pong']);
  });

  /**
   * The database client is given back whatever the verdict was. A probe that left a pool open would
   * keep the diagnostic process alive after its table was printed — the same defect the cache side
   * closes by disconnecting, on a service that has no `disconnect` of its own to fall back on.
   */
  it('closes the database client on both verdicts', async () => {
    const closed: string[] = [];
    const healthy = await probeServices(
      baseDeps({
        disconnectDatabase: () => {
          closed.push('healthy');
          return Promise.resolve();
        },
      }),
    );
    expect(healthy[0]).toBe(`POSTGRES=${PROBE_OK}`);

    await probeServices(
      baseDeps({
        assertDatabaseReachable: () => Promise.reject(new Error('unreachable')),
        disconnectDatabase: () => {
          closed.push('unhealthy');
          return Promise.resolve();
        },
      }),
    );

    expect(closed).toEqual(['healthy', 'unhealthy']);
  });

  /**
   * Every deadline is cancelled on the way out — the two teardown races and the ping's own. Each is
   * a `setTimeout` holding a rejection callback, and Node will not exit while one is armed, so a
   * diagnostic that printed its table would then sit there for the length of the longest wait.
   */
  it('leaves no deadline armed behind it', async () => {
    vi.useFakeTimers();
    try {
      await expect(probeServices(baseDeps())).resolves.toEqual([
        `POSTGRES=${PROBE_OK}`,
        `REDIS=${PROBE_OK}`,
      ]);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Callers that state no wait get the module's own default, so `doctor` does not have to know
   * how long a probe may take.
   */
  it('falls back to the default deadline when none is given', async () => {
    const deps = baseDeps();
    delete deps.timeoutMs;
    await expect(probeServices(deps)).resolves.toEqual([
      `POSTGRES=${PROBE_OK}`,
      `REDIS=${PROBE_OK}`,
    ]);
  });

  /**
   * A `ping` that never settles is the shape of the defect: the socket was accepted, so a
   * connect-only check called it healthy, while nothing ever answered. The deadline decides.
   */
  it(
    'reports the cache failure when PING never answers',
    async () => {
      const client = fakeRedis(() => new Promise<string>(() => undefined));
      const lines = await probeServices(baseDeps({ createRedisClient: () => client }));
      expect(lines).toEqual([`POSTGRES=${PROBE_OK}`, `REDIS=${REDIS_FAILURE}`]);
      expect(client.disconnected()).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );
});

describe('probeServices against a listener that is not the service', () => {
  /**
   * The measured defect, reproduced end to end with the real clients: a plain TCP listener holds
   * both instance ports and answers nothing. `ah_tcp_open` — what the two doctor rows used to be —
   * succeeds against it, which is how an unrelated container on the database port came to report
   * a healthy Postgres. Neither probe accepts it: the database never answers `SELECT 1` and the
   * cache never answers `PING`.
   */
  it(
    'fails both probes against a socket that accepts and answers nothing',
    async () => {
      const postgresPort = await silentListener();
      const redisPort = await silentListener();
      const lines = await probeServices<ReturnType<typeof createPrismaClient>>({
        env: {},
        loadConfig: () => ({
          DATABASE_URL: `postgresql://ah:ah@127.0.0.1:${String(postgresPort)}/agent_hangar_default`,
          REDIS_URL: `redis://127.0.0.1:${String(redisPort)}`,
        }),
        createDatabaseClient: (connectionString) => createPrismaClient({ connectionString }),
        assertDatabaseReachable,
        disconnectDatabase: disconnectPrisma,
        createRedisClient: createQueueConnection,
        timeoutMs: TEST_TIMEOUT_MS,
      });
      expect(lines).toEqual([`POSTGRES=${POSTGRES_FAILURE}`, `REDIS=${REDIS_FAILURE}`]);
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * The production wiring reads its two URLs through the real `loadConfig`, so the probe is
   * exercised through that path too rather than only through a hand-written stand-in.
   */
  it(
    'resolves both URLs through loadConfig',
    async () => {
      const postgresPort = await silentListener();
      const redisPort = await silentListener();
      const lines = await probeServices<ReturnType<typeof createPrismaClient>>({
        env: {
          DATABASE_URL: `postgresql://ah:ah@127.0.0.1:${String(postgresPort)}/agent_hangar_default`,
          REDIS_URL: `redis://127.0.0.1:${String(redisPort)}`,
        },
        loadConfig,
        createDatabaseClient: (connectionString) => createPrismaClient({ connectionString }),
        assertDatabaseReachable,
        disconnectDatabase: disconnectPrisma,
        createRedisClient: createQueueConnection,
        timeoutMs: TEST_TIMEOUT_MS,
      });
      expect(lines).toEqual([`POSTGRES=${POSTGRES_FAILURE}`, `REDIS=${REDIS_FAILURE}`]);
    },
    CASE_TIMEOUT_MS,
  );
});
