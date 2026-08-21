/** @vitest-environment node */
/**
 * Unit tests for the health route.
 *
 * Layer: unit.
 * Goal: every dependency is reported without the route ever throwing, the worker heartbeat is the
 * only source of the Docker facts, a silent worker is named as the silent one rather than blamed
 * on Docker, and no failure detail carries text a driver produced.
 * Mocks: the `bullmq` module; fake timers where a probe has to time out.
 */
import { healthResponse, workerHeartbeatKey } from '@agent-hangar/core';
import type { WorkerHeartbeat } from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import { readRequest } from '../testing/requests';
import { createTestContainer } from '../testing/test-container';
import type { TestContainer } from '../testing/test-container';
import { TIMED_OUT } from '../timeout';

import {
  DOCKER_UNREACHABLE,
  getHealth,
  IMAGE_MISSING,
  PROBE_TIMEOUT_MS,
  UNKNOWN_WITHOUT_WORKER,
  WORKER_SILENT,
} from './health';

vi.mock('bullmq', () => import('../testing/fake-queue'));

/** Instant every container in this file starts from. */
const NOW = new Date('2026-08-19T10:00:00.000Z');

/**
 * Writes a heartbeat for the instance under test.
 *
 * @param harness - The test container.
 * @param heartbeat - Values to store, merged over a healthy reading.
 */
async function writeHeartbeat(
  harness: TestContainer,
  heartbeat: Partial<WorkerHeartbeat> = {},
): Promise<void> {
  const payload: WorkerHeartbeat = {
    at: NOW.toISOString(),
    dockerOk: true,
    imagePresent: true,
    containers: 1,
    ...heartbeat,
  };
  await harness.doubles.redis.set(
    workerHeartbeatKey(harness.container.config.AH_INSTANCE),
    JSON.stringify(payload),
  );
}

/**
 * Calls the route and parses the answer against its contract.
 *
 * @param harness - The test container.
 * @returns The status and the parsed body.
 */
async function report(
  harness: TestContainer,
): Promise<{ status: number; body: ReturnType<typeof healthResponse.parse> }> {
  const response = await getHealth(harness.container, readRequest('/api/health'));
  return { status: response.status, body: healthResponse.parse(await response.json()) };
}

describe('getHealth', () => {
  /**
   * Everything reachable: the route reports the instance it belongs to and the ports it resolved
   * to, which is how a developer running three checkouts tells them apart.
   */
  it('reports a healthy instance with its ports', async () => {
    const harness = createTestContainer({ now: NOW });
    await writeHeartbeat(harness);
    const { status, body } = await report(harness);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.instance).toBe('test');
    expect(body.ports).toEqual({
      web: harness.container.config.WEB_PORT,
      postgres: harness.container.config.POSTGRES_PORT,
      redis: harness.container.config.REDIS_PORT,
    });
    expect(body.checks).toEqual({
      db: { ok: true },
      redis: { ok: true },
      docker: { ok: true },
      image: { ok: true },
      worker: { ok: true, lastSeenAt: NOW.toISOString() },
    });
  });

  /**
   * Without a heartbeat the web process knows nothing about Docker. The worker is the check that
   * fails, and Docker and the image say they are unknown rather than broken: reporting a stopped
   * worker as `docker: false` sends the user to repair a daemon that was answering all along.
   */
  it('blames the silent worker rather than Docker', async () => {
    const harness = createTestContainer({ now: NOW });
    const { body } = await report(harness);
    expect(body.ok).toBe(false);
    expect(body.checks.worker).toEqual({ ok: false, detail: WORKER_SILENT });
    expect(body.checks.docker).toEqual({ ok: false, detail: UNKNOWN_WITHOUT_WORKER });
    expect(body.checks.image).toEqual({ ok: false, detail: UNKNOWN_WITHOUT_WORKER });
  });

  /**
   * A heartbeat that arrived reports the worker alive and says when it last spoke, which is what
   * separates "never started" from "died a moment ago".
   */
  it('reports the worker alive with its last sighting', async () => {
    const harness = createTestContainer({ now: NOW });
    const at = new Date(NOW.getTime() - 5000).toISOString();
    await writeHeartbeat(harness, { at, dockerOk: false });
    const { body } = await report(harness);
    expect(body.checks.worker).toEqual({ ok: true, lastSeenAt: at });
    expect(body.checks.docker).toEqual({ ok: false, detail: DOCKER_UNREACHABLE });
  });

  /**
   * A heartbeat older than its lifetime is a worker that stopped writing, which is the same as no
   * worker at all — Redis may not have evicted the key yet.
   */
  it('treats a stale heartbeat as no heartbeat', async () => {
    const harness = createTestContainer({ now: NOW });
    await writeHeartbeat(harness, { at: new Date(NOW.getTime() - 120_000).toISOString() });
    const { body } = await report(harness);
    expect(body.checks.worker).toEqual({ ok: false, detail: WORKER_SILENT });
  });

  /**
   * A heartbeat that is not valid JSON, or does not satisfy the schema, is discarded rather than
   * partially trusted: another process writes that key.
   */
  it('discards an unreadable heartbeat', async () => {
    const harness = createTestContainer({ now: NOW });
    const key = workerHeartbeatKey(harness.container.config.AH_INSTANCE);
    await harness.doubles.redis.set(key, 'not json');
    expect((await report(harness)).body.checks.worker.detail).toBe(WORKER_SILENT);
    await harness.doubles.redis.set(key, JSON.stringify({ at: 'yesterday' }));
    expect((await report(harness)).body.checks.worker.detail).toBe(WORKER_SILENT);
  });

  /**
   * The two Docker facts are reported separately, because they have different fixes: a stopped
   * daemon and a missing image are not the same problem.
   */
  it('separates an unreachable daemon from a missing image', async () => {
    const harness = createTestContainer({ now: NOW });
    await writeHeartbeat(harness, { dockerOk: false, imagePresent: false });
    const { body } = await report(harness);
    expect(body.checks.docker).toEqual({ ok: false, detail: DOCKER_UNREACHABLE });
    expect(body.checks.image).toEqual({ ok: false, detail: IMAGE_MISSING });
  });

  /**
   * A rejected probe is reported by the classification core recognises, never by the driver's own
   * message: that message carries the connection string, password included.
   */
  it('reports a rejected probe without repeating the driver message', async () => {
    const harness = createTestContainer({ now: NOW });
    await writeHeartbeat(harness);
    const refused = Object.assign(new Error('connect ECONNREFUSED user:hunter2@host'), {
      code: 'ECONNREFUSED',
    });
    harness.doubles.prisma.queryFailure = refused;
    vi.spyOn(harness.doubles.redis, 'ping').mockRejectedValue(refused);

    const response = await getHealth(harness.container, readRequest('/api/health'));
    const text = await response.text();
    expect(text).not.toContain('hunter2');
    const body = healthResponse.parse(JSON.parse(text));
    expect(body.ok).toBe(false);
    expect(body.checks.db).toEqual({ ok: false, detail: 'ECONNREFUSED' });
    expect(body.checks.redis).toEqual({ ok: false, detail: 'ECONNREFUSED' });
    expect(harness.doubles.logOutput()).toContain('health probe failed');
  });

  /**
   * A dependency that accepts the connection and then never answers must not hold the response
   * open; the probe gives up and reports a timeout instead.
   */
  it('gives up on a probe that never answers', async () => {
    vi.useFakeTimers();
    try {
      const harness = createTestContainer({ now: NOW });
      harness.doubles.prisma.shouldHang = true;
      const pending = getHealth(harness.container, readRequest('/api/health'));
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
      const body = healthResponse.parse(await (await pending).json());
      expect(body.checks.db).toEqual({ ok: false, detail: TIMED_OUT });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Reading the heartbeat is bounded the same way: a Redis that accepted the connection and then
   * stopped answering must not stall the route.
   */
  it('gives up on a heartbeat read that never answers', async () => {
    vi.useFakeTimers();
    try {
      const harness = createTestContainer({ now: NOW });
      vi.spyOn(harness.doubles.redis, 'get').mockReturnValue(
        new Promise<string | null>(() => {
          // Never settles; the probe's own timer is what ends the wait.
        }),
      );
      const pending = getHealth(harness.container, readRequest('/api/health'));
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
      const body = healthResponse.parse(await (await pending).json());
      expect(body.checks.worker.detail).toBe(WORKER_SILENT);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A heartbeat read that rejects outright is the same as no heartbeat, and it must not turn into
   * a failed request.
   */
  it('survives a heartbeat read that rejects', async () => {
    const harness = createTestContainer({ now: NOW });
    vi.spyOn(harness.doubles.redis, 'get').mockRejectedValue(new Error('down'));
    const { status, body } = await report(harness);
    expect(status).toBe(200);
    expect(body.checks.worker.detail).toBe(WORKER_SILENT);
  });
});
