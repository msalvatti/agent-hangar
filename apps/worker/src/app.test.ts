/**
 * Unit tests for the worker application wiring.
 *
 * Layer: unit.
 * Goal: one consumer per queue with the concurrency and stalled-job settings a minutes-long turn
 * needs, an actionable log line when the image is missing without refusing to start, and a
 * shutdown that stops everything once, forcing it after the grace period.
 * Mocks: a recording consumer factory and the in-memory container.
 */
import { QUEUE_NAMES, WORKER_HEARTBEAT_INTERVAL_SEC } from '@agent-hangar/core';
import { FakeWorkspaceRunner } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { defaultWorkerFactories, probeWorkspaceImage, startWorker } from './app.js';
import type { ImageProbe } from './app.js';
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
function appContainer(test: TestContainer): {
  container: AppContainer;
  closed: string[];
  queue: FakeRedisClient;
} {
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
    fakeProviderEnv: test.fakeProviderEnv,
    claims: test.claims,
    close: () => {
      closed.push('container');
      return Promise.resolve();
    },
  };
  return { container, closed, queue };
}

/** Starts the application over the in-memory container. */
async function start(
  options: {
    blocking?: boolean;
    imagePresent?: boolean;
    /** Runs against the container before the worker boots, to set the state boot must react to. */
    seed?: (test: TestContainer) => Promise<void>;
    /** Replaces the image probe; a rejecting one is what an unreachable daemon looks like. */
    checkImage?: ImageProbe;
  } = {},
): Promise<{
  test: TestContainer;
  factory: FakeWorkerFactory;
  closed: string[];
  queue: FakeRedisClient;
  app: Awaited<ReturnType<typeof startWorker>>;
}> {
  const test = createTestContainer();
  await options.seed?.(test);
  const { container, closed, queue } = appContainer(test);
  const factory = createFakeWorkerFactory({ blocking: options.blocking ?? false });
  const app = await startWorker(container, {
    createWorker: factory.createWorker.bind(factory),
    checkImage:
      options.checkImage ?? ((): Promise<boolean> => Promise.resolve(options.imagePresent ?? true)),
  });
  return { test, factory, closed, queue, app };
}

/** Seeds the two rows a dead incarnation leaves: a teardown's and a scheduled run's. */
async function seedAbandoned(test: TestContainer): Promise<{ stopping: string; busyJob: string }> {
  const chat = await test.repos.chats.create({
    title: 'Task',
    repoUrl: 'https://github.com/octocat/Hello-World',
    baseBranch: 'main',
  });
  const chatWorkspace = await test.repos.workspaces.create({
    kind: 'CHAT',
    chatId: chat.id,
    runnerKind: 'fake',
    image: 'image',
    repoUrl: 'https://github.com/octocat/Hello-World',
    branch: 'main',
  });
  await test.repos.workspaces.setStatus(chatWorkspace.id, 'READY');
  await test.repos.workspaces.claimStatus(chatWorkspace.id, 'READY', 'STOPPING');

  const jobWorkspace = await test.repos.workspaces.create({
    kind: 'JOB',
    runnerKind: 'fake',
    image: 'image',
    repoUrl: 'https://github.com/octocat/Hello-World',
    branch: 'main',
  });
  await test.repos.workspaces.setStatus(jobWorkspace.id, 'READY');
  await test.repos.workspaces.claimStatus(jobWorkspace.id, 'READY', 'BUSY');

  return { stopping: chatWorkspace.id, busyJob: jobWorkspace.id };
}

/** The records the container collected, parsed back from the lines pino wrote. */
function records(logs: string[]): Record<string, unknown>[] {
  return logs.map((line) => JSON.parse(line) as Record<string, unknown>);
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

    // Both lines name the run and the classification. A driver's own message is never repeated —
    // Prisma and ioredis build theirs from the connection string, password included — so what is
    // left has to say which job it was and what kind of failure it was, or the line is unusable.
    expect(records(test.logs)).toContainEqual(
      expect.objectContaining({ msg: 'job failed', jobId: 'job-1', failure: 'unknown' }),
    );
    expect(records(test.logs)).toContainEqual(
      expect.objectContaining({ msg: 'worker error', failure: 'unknown' }),
    );
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
    const { factory, app, test } = await start({ blocking: true });

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
    // And nothing is warned about at all. The warning is what an operator reads as "work was
    // thrown away"; printed after a drain that finished — even wordlessly — it would report a loss
    // that did not happen on every clean stop.
    expect(records(test.logs).filter((record) => record.level === 40)).toStrictEqual([]);
    vi.useRealTimers();
  });

  /**
   * The schedulers are reconciled before any consumer starts, so a tick delivered immediately
   * finds a job the worker knows about.
   */
  it('reconciles the schedulers and reports it is ready', async () => {
    const { test } = await start();

    expect(test.queues.workspaceGc.scheduler('reap-idle')).toBeDefined();
    // The readiness line carries what an operator needs to tell two checkouts apart on one
    // machine: which instance came up, whether it will really build containers, and how many
    // turns it will run at once.
    expect(records(test.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'worker ready',
        instance: test.config.AH_INSTANCE,
        runner: test.runner.kind,
        concurrency: test.config.WORKER_TURN_CONCURRENCY,
      }),
    );
  });

  /**
   * A workspace still marked `STOPPING` at boot belongs to an incarnation of this worker that is
   * gone — a crash, or a job abandoned past the shutdown grace period — because a live teardown
   * cannot exist before any consumer has started. It is closed out and reported, so an operator
   * sees that a container was left behind rather than having to notice the leak later.
   */
  it('closes out a workspace a dead incarnation left half-torn-down, and says so', async () => {
    let workspaceId = '';
    const { test } = await start({
      seed: async (seeded) => {
        const chat = await seeded.repos.chats.create({
          title: 'Task',
          repoUrl: 'https://github.com/octocat/Hello-World',
          baseBranch: 'main',
        });
        const created = await seeded.repos.workspaces.create({
          kind: 'CHAT',
          chatId: chat.id,
          runnerKind: 'fake',
          image: 'image',
          repoUrl: 'https://github.com/octocat/Hello-World',
          branch: 'main',
        });
        workspaceId = created.id;
        await seeded.repos.workspaces.setStatus(created.id, 'READY');
        await seeded.repos.workspaces.claimStatus(created.id, 'READY', 'STOPPING');
      },
    });

    expect((await test.repos.workspaces.get(workspaceId))?.status).toBe('DESTROYED');
    // How many were closed out, not merely that some were: one is a crash, twelve is a worker
    // that has been dying repeatedly, and the count is the difference between the two.
    expect(records(test.logs)).toContainEqual(expect.objectContaining({ recovered: 1 }));
    expect(test.logs.join('')).toContain(
      'closed out workspaces the last incarnation was still holding',
    );
  });

  /**
   * The boot steps have different dependencies, and the recovery has the fewest: it reads and
   * writes rows and never touches Docker. Running it after the probe made that untrue in the one
   * situation it exists for — a daemon that is down is also the likeliest reason a worker died
   * holding those rows — because the probe rejects rather than reporting, by its own deliberate
   * design, and took the whole boot with it.
   *
   * So the assertion is made through `startWorker` rather than against the recovery directly: a
   * test that called it directly would pass either way, which is the shape of check this project
   * has now recorded several times.
   */
  it('closes out what a dead incarnation left even when the daemon is unreachable', async () => {
    let ids = { stopping: '', busyJob: '' };
    const test = createTestContainer();
    ids = await seedAbandoned(test);
    const { container } = appContainer(test);
    const factory = createFakeWorkerFactory({ blocking: false });

    await expect(
      startWorker(container, {
        createWorker: factory.createWorker.bind(factory),
        checkImage: () => Promise.reject(new Error('connect ENOENT /var/run/docker.sock')),
      }),
    ).rejects.toThrow('docker.sock');

    expect((await test.repos.workspaces.get(ids.stopping))?.status).toBe('DESTROYED');
    // A `BUSY` row is not this pass's to take, whatever the daemon is doing: its owner is executing
    // inside that container, and a sibling worker's hold is invisible from here.
    expect((await test.repos.workspaces.get(ids.busyJob))?.status).toBe('BUSY');
    expect(factory.workers).toHaveLength(0);
  });

  /**
   * A missing image is reported with the command that builds it, and the worker still starts: the
   * user fixes it from the UI banner while the process keeps running.
   */
  it('reports a missing image without refusing to start', async () => {
    const { test, factory } = await start({ imagePresent: false });

    // Naming the tag is the point: the operator has to know which image is missing, and two
    // checkouts on one machine are configured with different ones.
    expect(records(test.logs)).toContainEqual(
      expect.objectContaining({ image: test.config.WORKSPACE_IMAGE }),
    );
    expect(test.logs.join('')).toContain('pnpm infra:image');
    expect(factory.workers).toHaveLength(3);
  });

  /**
   * A present image says nothing, so the log stays readable.
   */
  it('says nothing when the image is present', async () => {
    const { test } = await start();

    expect(test.logs.join('')).not.toContain('pnpm infra:image');
    // And a boot that recovered nothing says nothing about recovery either. The warning is read as
    // "a previous incarnation died"; printed on every clean start it would say that of all of them.
    expect(test.logs.join('')).not.toContain('the last incarnation was still holding');
  });

  /**
   * Shutting down stops every consumer and only then releases the container: a consumer still
   * reading Redis after the connection closed would log errors on the way out.
   */
  it('stops the heartbeat and says so before anything else', async () => {
    vi.useFakeTimers();
    const { app, queue, test } = await start();
    const beatsWhileRunning = queue.writes.length;

    await app.shutdown();
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_SEC * 4 * 1000);

    // Nothing more is published. A heartbeat left running writes a key that says this worker is
    // healthy, with a fresh lifetime, for as long as the process lingers — and the health card
    // would show a worker that has stopped taking jobs as ready to take them.
    expect(queue.writes).toHaveLength(beatsWhileRunning);
    // And the stop is announced: this is the first line of a shutdown, and an operator watching a
    // process that will not exit needs to know it began.
    expect(records(test.logs)).toContainEqual(expect.objectContaining({ msg: 'stopping workers' }));
    vi.useRealTimers();
  });

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
    // Which of the two abandonments this was: turns that were still running when the grace period
    // ran out, not a drain that could not be asked for.
    expect(test.logs.join('')).toContain('workers did not stop in time');
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
    // And the other wording: nothing was waited out here, the drain itself could not be asked for.
    // An operator chasing a worker that keeps abandoning jobs needs the two told apart.
    expect(test.logs.join('')).toContain('the drain failed outright');
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
   * Without an injected probe the application uses the default one, and that default reports what
   * the host actually has: a boot on a host missing the configured image prints the command that
   * builds it, on a checkout where nothing has ever been created.
   */
  it('falls back to a default probe that reports a missing image', async () => {
    const test = createTestContainer({ runner: new FakeWorkspaceRunner({ images: [] }) });
    const { container } = appContainer(test);
    const factory = createFakeWorkerFactory();

    await startWorker(container, { createWorker: factory.createWorker.bind(factory) });

    expect(test.logs.join('')).toContain('pnpm infra:image');
    expect(factory.workers).toHaveLength(3);
  });

  /**
   * The same default on a host that has the image says nothing, so the log stays readable.
   */
  it('falls back to a default probe that stays quiet when the image is there', async () => {
    const test = createTestContainer({
      runner: new FakeWorkspaceRunner({ images: ['agent-hangar/workspace:test'] }),
    });
    const { container } = appContainer(test);
    const factory = createFakeWorkerFactory();

    await startWorker(container, { createWorker: factory.createWorker.bind(factory) });

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

describe('probeWorkspaceImage', () => {
  /**
   * The probe answers about the image the configuration names, not about whether the daemon
   * happened to reply to something.
   */
  it('answers from what the host has', async () => {
    const runner = new FakeWorkspaceRunner({ images: ['agent-hangar/workspace:test'] });

    await expect(probeWorkspaceImage(runner, 'agent-hangar/workspace:test')).resolves.toBe(true);
    await expect(probeWorkspaceImage(runner, 'agent-hangar/workspace:other')).resolves.toBe(false);
  });

  /**
   * A host that could not be asked is not a host without the image: the rejection is passed on, so
   * the boot fails loudly instead of printing a build command that would not help.
   */
  it('rejects rather than reporting absence when the host cannot be asked', async () => {
    const runner = new FakeWorkspaceRunner();
    vi.spyOn(runner, 'imageExists').mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(probeWorkspaceImage(runner, 'agent-hangar/workspace:test')).rejects.toThrow(
      'connect ECONNREFUSED',
    );
  });
});
