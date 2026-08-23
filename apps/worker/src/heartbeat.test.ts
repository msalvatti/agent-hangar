/**
 * Unit tests for the health heartbeat.
 *
 * Layer: unit.
 * Goal: the key, its lifetime and its payload are what the health route reads; a daemon that does
 * not answer is published as a reading rather than thrown; the image is reported from what the
 * host answers on this beat rather than from what a previous create happened to observe; and a
 * failed write never takes the worker down.
 * Mocks: the shared recording Redis double and the fake workspace runner.
 */
import {
  WORKER_HEARTBEAT_INTERVAL_SEC,
  WORKER_HEARTBEAT_TTL_SEC,
  workerHeartbeatKey,
  workerHeartbeatSchema,
} from '@agent-hangar/core';
import { FakeClock, FakeWorkspaceRunner } from '@agent-hangar/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startHeartbeat, writeHeartbeat } from './heartbeat.js';
import type { HeartbeatDeps } from './heartbeat.js';
import { createTestContainer, FakeRedisClient } from './testing/index.js';

/** Builds the heartbeat's collaborators over in-memory doubles. */
function setup(runner = new FakeWorkspaceRunner()): {
  deps: HeartbeatDeps;
  redis: FakeRedisClient;
  test: ReturnType<typeof createTestContainer>;
} {
  const test = createTestContainer({ clock: new FakeClock(), runner });
  const redis = new FakeRedisClient();
  return {
    redis,
    test,
    deps: {
      config: test.config,
      clock: test.clock,
      logger: test.logger,
      runner: test.runner,
      redis: { queue: redis },
    },
  };
}

/** Reads back the single heartbeat a test wrote. */
function published(redis: FakeRedisClient): unknown {
  return workerHeartbeatSchema.parse(JSON.parse(redis.writes.at(-1)?.value ?? '{}'));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('writeHeartbeat', () => {
  /**
   * The key, the lifetime and the payload are the health route's read contract, so all three are
   * asserted rather than assumed.
   */
  it('publishes the readings under the instance key, with a lifetime', async () => {
    const { deps, redis, test } = setup();

    const heartbeat = await writeHeartbeat(deps);

    expect(redis.writes).toHaveLength(1);
    expect(redis.writes[0]).toMatchObject({
      key: workerHeartbeatKey('w2b-unit'),
      // The expiry option, not just the number beside it: a `SET` that carries the seconds without
      // naming the mode is refused by Redis, and one Redis accepted without it would leave a key
      // that never expires — a worker that died would go on reporting itself healthy for good.
      mode: 'EX',
      seconds: WORKER_HEARTBEAT_TTL_SEC,
    });
    expect(heartbeat).toEqual({
      at: test.clock.now().toISOString(),
      dockerOk: true,
      imagePresent: true,
      containers: 0,
    });
    expect(published(redis)).toEqual(heartbeat);
  });

  /**
   * The container count is what the health card shows, so it is read from the runner rather than
   * from the database: a container the database forgot still costs memory.
   */
  it('counts the containers this instance owns', async () => {
    const { deps, redis } = setup();
    await deps.runner.create({
      workspaceId: 'ws-1',
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits: { cpus: 1, memoryBytes: 1, pids: 1 },
      labels: { 'ah.instance': 'w2b-unit' },
    });

    await writeHeartbeat(deps);

    expect(published(redis)).toMatchObject({ containers: 1 });
  });

  /**
   * And only this instance's. Two checkouts share one Docker daemon by design, so a count taken
   * without the instance label would show each of them the other's containers and an operator
   * would go looking for workspaces this worker never created.
   */
  it('does not count the containers of another instance', async () => {
    const { deps, redis } = setup();
    await deps.runner.create({
      workspaceId: 'ws-other',
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits: { cpus: 1, memoryBytes: 1, pids: 1 },
      labels: { 'ah.instance': 'some-other-checkout' },
    });

    await writeHeartbeat(deps);

    expect(published(redis)).toMatchObject({ containers: 0 });
  });

  /**
   * A daemon that does not answer is the reading the health card exists to show; the worker keeps
   * running and publishes it, and the image cannot be claimed present when nothing was asked.
   */
  it('publishes an unreachable daemon rather than failing', async () => {
    const { deps, redis, test } = setup();
    vi.spyOn(deps.runner, 'list').mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );

    await writeHeartbeat(deps);

    expect(published(redis)).toMatchObject({
      dockerOk: false,
      imagePresent: false,
      containers: 0,
    });
    // The line says what went wrong, not only that something did: an operator reading "the runner
    // did not answer" and nothing else has no way to tell a daemon that is down from one that
    // refused this user.
    expect(JSON.parse(test.logs[0] ?? '{}')).toMatchObject({
      msg: 'the workspace runner did not answer the health probe',
      failure: expect.stringContaining('ECONNREFUSED') as unknown,
    });
  });

  /**
   * A host that does not have the configured image is reported as missing on the very first beat,
   * before any workspace has been created. That is precisely when an operator who has never run
   * `pnpm infra:image` is looking at the card, so a reading carried over from a create that never
   * happened would tell them the one thing they cannot act on.
   */
  it('reports an image the host does not have as missing', async () => {
    const { deps, redis } = setup(new FakeWorkspaceRunner({ images: [] }));

    await writeHeartbeat(deps);

    expect(published(redis)).toMatchObject({ dockerOk: true, imagePresent: false });
  });

  /**
   * The image the configuration names is the one asked about; another instance's tag on the same
   * host is not this instance's image.
   */
  it('asks the host about the image this instance is configured with', async () => {
    const { deps, redis } = setup(
      new FakeWorkspaceRunner({ images: ['agent-hangar/workspace:test'] }),
    );

    await writeHeartbeat(deps);
    expect(published(redis)).toMatchObject({ imagePresent: true });

    const otherInstance: HeartbeatDeps = {
      ...deps,
      config: { ...deps.config, WORKSPACE_IMAGE: 'agent-hangar/workspace:other' },
    };
    await writeHeartbeat(otherInstance);
    expect(published(redis)).toMatchObject({ imagePresent: false });
  });

  /**
   * A host that answered the listing but could not be asked about the image has told the worker
   * nothing about either, so the card says Docker is down instead of naming an image the operator
   * would then rebuild for no reason.
   */
  it('reports a host that could not be asked about the image as unreachable', async () => {
    const { deps, redis, test } = setup();
    vi.spyOn(deps.runner, 'imageExists').mockRejectedValue(new Error('daemon closed the socket'));

    await writeHeartbeat(deps);

    expect(published(redis)).toMatchObject({ dockerOk: false, imagePresent: false });
    expect(test.logs.join('')).toContain('did not answer the health probe');
  });
});

describe('startHeartbeat', () => {
  /**
   * The first reading is published at once — a worker that just started must not look dead for
   * half a minute — and then rewritten well inside the key's lifetime.
   */
  it('publishes at once and keeps rewriting', async () => {
    vi.useFakeTimers();
    const { deps, redis } = setup();

    const running = await startHeartbeat(deps);
    expect(redis.writes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_SEC * 1000);
    expect(redis.writes).toHaveLength(2);

    running.stop();
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_SEC * 1000);
    expect(redis.writes).toHaveLength(2);
  });

  /**
   * A health key that could not be refreshed is a reason to log, never a reason to stop running
   * turns.
   */
  it('survives a write it could not make', async () => {
    vi.useFakeTimers();
    const { deps, redis, test } = setup();
    vi.spyOn(redis, 'set').mockRejectedValue(
      Object.assign(new Error('connection is closed'), { code: 'ECONNRESET' }),
    );

    const running = await startHeartbeat(deps);
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_SEC * 1000);
    running.stop();

    // The line names the classification and never the driver's own words: an ioredis message
    // carries the connection string, password included. Naming nothing at all would be no better
    // for the operator, who would learn only that a write failed.
    expect(JSON.parse(test.logs.at(-1) ?? '{}')).toMatchObject({
      msg: 'publishing the worker heartbeat failed',
      failure: 'ECONNRESET',
    });
    expect(test.logs.at(-1)).not.toContain('connection is closed');
  });

  /**
   * The interval never holds the process open. A worker that has finished its jobs and been asked
   * to stop must exit, and a referenced interval would keep the event loop alive indefinitely —
   * the operator would see a process that ignores the shutdown it was given.
   */
  it('leaves the rewrite timer unreferenced', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const { deps } = setup();

    const running = await startHeartbeat(deps);
    const timer = intervals.mock.results[0]?.value as NodeJS.Timeout;
    running.stop();

    expect(timer.hasRef()).toBe(false);
  });
});
