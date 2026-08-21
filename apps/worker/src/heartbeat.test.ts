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
    expect(test.logs.join('')).toContain('did not answer the health probe');
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
    vi.spyOn(redis, 'set').mockRejectedValue(new Error('connection is closed'));

    const running = await startHeartbeat(deps);
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_SEC * 1000);
    running.stop();

    expect(test.logs.join('')).toContain('publishing the worker heartbeat failed');
  });
});
