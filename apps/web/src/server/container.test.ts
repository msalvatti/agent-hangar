/** @vitest-environment node */
/**
 * Unit tests for the server container.
 *
 * Layer: unit.
 * Goal: injected collaborators are used as given, the real ones are built lazily, the process-wide
 * instance is cached across module reloads, and disposal closes every connection exactly once.
 * Mocks: the `bullmq` module (the queues would otherwise open a Redis connection).
 */
import { SSE_HEARTBEAT_MS } from '@agent-hangar/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createServerContainer,
  disposeServerContainer,
  getServerContainer,
  SSE_BLOCK_MS,
} from './container';
import { createTestContainer, TEST_ENV } from './testing/test-container';

vi.mock('bullmq', () => import('./testing/fake-queue'));

/**
 * Runs a block with a controlled `process.env`, so the loader's default source is deterministic.
 *
 * @param env - Variables to expose.
 * @param run - Block to run.
 * @returns Whatever the block returns.
 */
async function withEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('AH_') || name.startsWith('CONDUCTOR_')) {
      Reflect.deleteProperty(process.env, name);
    }
  }
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const name of Object.keys(process.env)) {
      Reflect.deleteProperty(process.env, name);
    }
    Object.assign(process.env, saved);
  }
}

afterEach(async () => {
  await disposeServerContainer();
});

describe('createServerContainer', () => {
  /**
   * Injection is total: a container built entirely from doubles reaches nothing real, which is
   * what makes a route test a unit test.
   */
  it('uses every injected collaborator', () => {
    const { container } = createTestContainer();
    const rebuilt = createServerContainer(container);
    expect(rebuilt.repos).toBe(container.repos);
    expect(rebuilt.redis).toBe(container.redis);
    expect(rebuilt.queues).toBe(container.queues);
    expect(rebuilt.secrets).toBe(container.secrets);
    expect(rebuilt.github).toBe(container.github);
    expect(rebuilt.clock).toBe(container.clock);
    expect(rebuilt.sse).toBe(container.sse);
  });

  /**
   * With nothing injected the container reads the environment and builds the real collaborators.
   * None of them connects: the assertion that the call returns at all is the assertion that
   * construction is free of I/O.
   */
  it('builds real collaborators without opening a connection', async () => {
    await withEnv(TEST_ENV, async () => {
      const container = createServerContainer();
      expect(container.config.AH_INSTANCE).toBe('test');
      expect(container.sse).toEqual({ heartbeatMs: SSE_HEARTBEAT_MS, blockMs: SSE_BLOCK_MS });
      expect(typeof container.clock.now()).toBe('object');
      await container.dispose();
    });
  });

  /**
   * Disposal closes the queues, drops the Redis connection and disconnects Prisma, and a second
   * call is a no-op: Next.js may tear a route module down more than once.
   */
  it('disposes every connection exactly once', async () => {
    const { container, doubles } = createTestContainer();
    const rebuilt = createServerContainer(container);
    await rebuilt.dispose();
    await rebuilt.dispose();
    expect(doubles.queues.chatTurns.closed).toBe(true);
    expect(doubles.queues.scheduledJobs.closed).toBe(true);
    expect(doubles.queues.workspaceGc.closed).toBe(true);
    expect(doubles.redis.closed).toBe(true);
    expect(doubles.prisma.disconnected).toBe(true);
  });
});

describe('getServerContainer', () => {
  /**
   * The instance is cached on `globalThis`, so the Next.js dev server reusing a module does not
   * leak a Prisma pool and a Redis connection per edit.
   */
  it('returns one container per process', async () => {
    await withEnv(TEST_ENV, async () => {
      expect(getServerContainer()).toBe(getServerContainer());
      await disposeServerContainer();
    });
  });

  /**
   * Disposing clears the cache, so the next caller gets a fresh container rather than one whose
   * connections are already closed.
   */
  it('builds a new container after disposal', async () => {
    await withEnv(TEST_ENV, async () => {
      const first = getServerContainer();
      await disposeServerContainer();
      expect(getServerContainer()).not.toBe(first);
      await disposeServerContainer();
    });
  });

  /**
   * Disposing when nothing was ever built is harmless, which matters because shutdown hooks run
   * whether or not a request was served.
   */
  it('tolerates disposal with no cached container', async () => {
    await expect(disposeServerContainer()).resolves.toBeUndefined();
  });
});
