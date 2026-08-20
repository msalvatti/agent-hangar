/**
 * Unit tests for the worker application wiring.
 *
 * Layer: unit.
 * Goal: one consumer per queue with the concurrency and stalled-job settings a minutes-long turn
 * needs, an actionable log line when the image is missing without refusing to start, and a
 * shutdown that stops everything once, forcing it after the grace period.
 * Mocks: a recording consumer factory and the in-memory container.
 */
import { QUEUE_NAMES } from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import { defaultWorkerFactories, probeRunnerReachable, startWorker } from './app.js';
import type { WorkerContainer } from './container.js';
import { SHUTDOWN_GRACE_MS, WORKER_RELIABILITY } from './processors/constants.js';
import {
  createFakeWorkerFactory,
  createTestContainer,
  FakeDatabaseClient,
  FakeRedisClient,
} from './testing/index.js';
import type { FakeWorkerFactory, TestContainer } from './testing/index.js';

/** The container shape `startWorker` needs, over the in-memory collaborators. */
type AppContainer = WorkerContainer<FakeDatabaseClient, FakeRedisClient>;

/** Builds a container `startWorker` accepts, recording whether it was closed. */
function appContainer(test: TestContainer): { container: AppContainer; closed: string[] } {
  const closed: string[] = [];
  const queue = new FakeRedisClient({ role: 'queue' });
  const container: AppContainer = {
    config: test.config,
    workerEnv: { WORKSPACE_RUNNER: 'fake' },
    logger: test.logger,
    clock: test.clock,
    prisma: new FakeDatabaseClient(),
    repos: test.repos,
    redis: {
      queue,
      worker: new FakeRedisClient({ role: 'worker' }),
      subscriber: queue.duplicate(),
    },
    secrets: test.secrets,
    redactor: test.redactor,
    runner: test.runner,
    publisher: test.publisher,
    commands: test.commands,
    queues: test.queues,
    imageStatus: test.imageStatus,
    fakeProviderEnv: test.fakeProviderEnv,
    claims: test.claims,
    close: () => {
      closed.push('container');
      return Promise.resolve();
    },
  };
  return { container, closed };
}

/** Starts the application over the in-memory container. */
async function start(options: { blocking?: boolean; imagePresent?: boolean } = {}): Promise<{
  test: TestContainer;
  factory: FakeWorkerFactory;
  closed: string[];
  app: Awaited<ReturnType<typeof startWorker>>;
}> {
  const test = createTestContainer();
  const { container, closed } = appContainer(test);
  const factory = createFakeWorkerFactory({ blocking: options.blocking ?? false });
  const app = await startWorker(container, {
    createWorker: factory.createWorker.bind(factory),
    checkImage: () => Promise.resolve(options.imagePresent ?? true),
  });
  return { test, factory, closed, app };
}

describe('startWorker', () => {
  /**
   * One consumer per queue, and only the turn queue runs more than one job at a time: a scheduled
   * run and a collection pass each own the whole instance's containers while they run.
   */
  it('creates one consumer per queue with the right concurrency', async () => {
    const { factory, test } = await start();

    expect(factory.workers.map((worker) => worker.name)).toEqual([
      QUEUE_NAMES.chatTurns,
      QUEUE_NAMES.scheduledJobs,
      QUEUE_NAMES.workspaceGc,
    ]);
    expect(factory.workers.map((worker) => worker.options.concurrency)).toEqual([
      test.config.WORKER_TURN_CONCURRENCY,
      1,
      1,
    ]);
  });

  /**
   * A turn holds its job for minutes, so every consumer carries the lock and stalled-scan settings
   * that keep BullMQ from deciding the worker died mid-turn.
   */
  it('creates every consumer with the stalled-job settings a long turn needs', async () => {
    const { factory } = await start();

    for (const worker of factory.workers) {
      expect(worker.options).toMatchObject(WORKER_RELIABILITY);
    }
  });

  /**
   * Failures are logged rather than silently swallowed by BullMQ.
   */
  it('subscribes to the failure and error events of every consumer', async () => {
    const { factory } = await start();

    for (const worker of factory.workers) {
      expect(worker.events).toEqual(['failed', 'error']);
    }
  });

  /**
   * BullMQ swallows a processor rejection into its own event, so the handlers are what make a
   * failed job visible at all.
   */
  it('logs a failed job and a worker error', async () => {
    const { factory, test } = await start();
    const [turns] = factory.workers;

    turns?.emit('failed', { id: 'job-1' }, new Error('boom'));
    turns?.emit('error', new Error('connection lost'));

    expect(test.logs.join('')).toContain('job failed');
    expect(test.logs.join('')).toContain('worker error');
  });

  /**
   * A rejection reported without the job it belongs to is still logged.
   */
  it('logs a failure with no job attached', async () => {
    const { factory, test } = await start();

    factory.workers[0]?.emit('failed', undefined, new Error('boom'));

    expect(test.logs.join('')).toContain('job failed');
  });

  /**
   * A consumer whose jobs finish within the grace period is closed once, gracefully: the drain is
   * what the grace period is spent on, and `close` follows the answer it gave.
   */
  it('does not force a consumer that stopped in time', async () => {
    vi.useFakeTimers();
    const { factory, app } = await start({ blocking: true });

    const stopping = app.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    for (const worker of factory.workers) {
      worker.resolvePause();
    }
    await vi.advanceTimersByTimeAsync(0);
    for (const worker of factory.workers) {
      worker.resolveClose();
    }
    await stopping;

    expect(factory.workers.map((worker) => worker.closes)).toEqual([[false], [false], [false]]);
    expect(factory.workers.map((worker) => worker.pauses)).toEqual([1, 1, 1]);
    vi.useRealTimers();
  });

  /**
   * The schedulers are reconciled before any consumer starts, so a tick delivered immediately
   * finds a job the worker knows about.
   */
  it('reconciles the schedulers and reports it is ready', async () => {
    const { test } = await start();

    expect(test.queues.workspaceGc.scheduler('reap-idle')).toBeDefined();
    expect(test.logs.join('')).toContain('worker ready');
  });

  /**
   * A missing image is reported with the command that builds it, and the worker still starts: the
   * user fixes it from the UI banner while the process keeps running.
   */
  it('reports a missing image without refusing to start', async () => {
    const { test, factory } = await start({ imagePresent: false });

    expect(test.logs.join('')).toContain('pnpm infra:image');
    expect(factory.workers).toHaveLength(3);
  });

  /**
   * A present image says nothing, so the log stays readable.
   */
  it('says nothing when the image is present', async () => {
    const { test } = await start();

    expect(test.logs.join('')).not.toContain('pnpm infra:image');
  });

  /**
   * Shutting down stops every consumer and only then releases the container: a consumer still
   * reading Redis after the connection closed would log errors on the way out.
   */
  it('stops every consumer, then releases the container', async () => {
    const { factory, closed, app } = await start();

    await app.shutdown();

    expect(factory.workers.map((worker) => worker.closes)).toEqual([[false], [false], [false]]);
    expect(closed).toHaveLength(1);
  });

  /**
   * Two signals arrive as two handlers; the second must join the shutdown already running rather
   * than releasing everything twice.
   */
  it('shuts down at most once', async () => {
    const { closed, app } = await start();

    await Promise.all([app.shutdown(), app.shutdown()]);
    await app.shutdown();

    expect(closed).toHaveLength(1);
  });

  /**
   * A turn that refuses to end must not stop the process from exiting. BullMQ answers every close
   * after the first with the first one's promise, so the forced close has to be the only close
   * this worker ever gets — a graceful one first would swallow it and the shutdown would hang past
   * the grace period it advertises.
   */
  it('forces the close after the grace period', async () => {
    vi.useFakeTimers();
    const { factory, closed, app, test } = await start({ blocking: true });

    const stopping = app.shutdown();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
    await stopping;

    expect(factory.workers.map((worker) => worker.closes)).toEqual([[true], [true], [true]]);
    expect(test.logs.join('')).toContain('abandoning jobs still in flight');
    expect(closed).toHaveLength(1);
    vi.useRealTimers();
  });

  /**
   * A drain that fails outright — the connection is already gone — says nothing about the jobs
   * still in flight, so it is treated as the drain that did not happen and the close is forced.
   * The alternative is a process that never exits because its shutdown rejected.
   */
  it('forces the close when the drain itself fails', async () => {
    vi.useFakeTimers();
    const { factory, closed, app, test } = await start({ blocking: true });

    const stopping = app.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    for (const worker of factory.workers) {
      worker.rejectPause(new Error('connection is already gone'));
    }
    await stopping;

    expect(factory.workers.map((worker) => worker.closes)).toEqual([[true], [true], [true]]);
    expect(test.logs.join('')).toContain('abandoning jobs still in flight');
    expect(closed).toHaveLength(1);
    vi.useRealTimers();
  });

  /**
   * A close that rejects — a connection that dropped while the consumer was being shut down — must
   * not take the container's clients with it: a process on its way out would keep a Prisma pool
   * and every owned connection open. They are released in a `finally`, and the failure is still
   * propagated so the entry point can report it and exit nonzero.
   */
  it('releases the container even when a close rejects', async () => {
    const { factory, closed, app } = await start();
    for (const worker of factory.workers) {
      vi.spyOn(worker, 'close').mockRejectedValue(new Error('connection is already gone'));
    }

    await expect(app.shutdown()).rejects.toThrow('connection is already gone');

    expect(closed).toHaveLength(1);
    vi.restoreAllMocks();
  });

  /**
   * Without an injected probe the application uses the default one, which asks the runner rather
   * than assuming the daemon is there.
   */
  it('falls back to the default image probe', async () => {
    const test = createTestContainer();
    const { container } = appContainer(test);
    const factory = createFakeWorkerFactory();

    await startWorker(container, { createWorker: factory.createWorker.bind(factory) });

    expect(test.runner.calls.some((call) => call.method === 'list')).toBe(true);
    expect(test.logs.join('')).not.toContain('pnpm infra:image');
  });
});

describe('defaultWorkerFactories', () => {
  /**
   * The production wiring is BullMQ's own factory, referenced rather than wrapped, so the two
   * cannot drift in the options they forward.
   */
  it('creates consumers through the shared BullMQ factory', () => {
    expect(typeof defaultWorkerFactories.createWorker).toBe('function');
    expect(defaultWorkerFactories.checkImage).toBeUndefined();
  });
});

describe('probeRunnerReachable', () => {
  /**
   * The default probe asks the runner for this instance's workspaces: that proves the daemon
   * answers, which is the half of the check worth failing loudly about at boot.
   */
  it('lists this instance and reports the runner as usable', async () => {
    const test = createTestContainer();

    await expect(
      probeRunnerReachable(test.runner, test.config.WORKSPACE_IMAGE, 'w2b-unit'),
    ).resolves.toBe(true);
    expect(test.runner.calls.at(-1)).toEqual({
      method: 'list',
      args: [{ 'ah.instance': 'w2b-unit' }],
    });
  });
});
