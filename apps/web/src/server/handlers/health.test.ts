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
import { healthResponse, workerHeartbeatKey, WORKER_HEARTBEAT_TTL_SEC } from '@agent-hangar/core';
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
    // Strictly: a check carrying `detail: undefined` beside its `ok` is a check the contract does
    // not describe, and one that reaches the browser as a key with no value.
    expect(body.checks).toStrictEqual({
      db: { ok: true },
      redis: { ok: true },
      docker: { ok: true },
      image: { ok: true },
      worker: { ok: true, lastSeenAt: NOW.toISOString() },
    });
    // The database is made to do something rather than merely connected to: a pool hands back a
    // connection that was opened long ago, and only a statement proves the server behind it is
    // still answering.
    expect(harness.doubles.prisma.queries).toStrictEqual(['SELECT 1']);
    // Never cached. This answer is read by a page that polls it, and a proxy or a browser holding
    // the last one would show a database that came back as still unreachable.
    expect(
      (await getHealth(harness.container, readRequest('/api/health'))).headers.get('Cache-Control'),
    ).toBe('no-store');
  });

  /**
   * One dependency down is enough to say the instance is not healthy. Reported the other way
   * round, a page whose database is gone would show a green banner because Redis answered.
   */
  it.each([
    ['the database', 'db'],
    ['redis', 'redis'],
  ])('is not ok when %s alone is unreachable', async (_case, failing) => {
    const harness = createTestContainer({ now: NOW });
    await writeHeartbeat(harness);
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    if (failing === 'db') {
      harness.doubles.prisma.queryFailure = refused;
    } else {
      vi.spyOn(harness.doubles.redis, 'ping').mockRejectedValue(refused);
    }

    const { body } = await report(harness);

    expect(body.ok).toBe(false);
    expect(body.checks[failing === 'db' ? 'db' : 'redis']).toStrictEqual({
      ok: false,
      detail: 'ECONNREFUSED',
    });
  });

  /**
   * A heartbeat exactly as old as its lifetime is still the worker's last word: the key is written
   * on a shorter interval than it lives, so the reading at the boundary is the one that arrived a
   * whole interval ago and has not yet been replaced. Refused there, a healthy worker flickers.
   */
  it('accepts a heartbeat exactly as old as its lifetime', async () => {
    const harness = createTestContainer({ now: NOW });
    const at = new Date(NOW.getTime() - WORKER_HEARTBEAT_TTL_SEC * 1000).toISOString();
    await writeHeartbeat(harness, { at });

    expect((await report(harness)).body.checks.worker).toStrictEqual({ ok: true, lastSeenAt: at });
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
    // The four sentences are written out here as well as read from the exports: they are what the
    // settings page shows a user whose instance is not healthy, and compared only against the
    // constants they came from every one of them could be emptied without a check noticing.
    expect(body.checks.worker).toStrictEqual({ ok: false, detail: 'worker has not reported' });
    expect(body.checks.docker).toStrictEqual({
      ok: false,
      detail: 'unknown while the worker is down',
    });
    expect(body.checks.image).toStrictEqual({
      ok: false,
      detail: 'unknown while the worker is down',
    });
    expect([WORKER_SILENT, UNKNOWN_WITHOUT_WORKER]).toStrictEqual([
      'worker has not reported',
      'unknown while the worker is down',
    ]);
  });

  /**
   * A rebound host is refused here as everywhere else. This route answers before authentication of
   * any kind, and a `Host` a DNS rebinding attack chose is what turns a page on another origin
   * into a reader of this instance's ports and its dependency state.
   */
  it('refuses a request addressed to a host this instance does not answer for', async () => {
    const harness = createTestContainer({ now: NOW });
    const rebound = new Request('http://attacker.test/api/health', {
      headers: { host: 'attacker.test' },
    });

    const response = await getHealth(harness.container, rebound);

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('ports');
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
    expect(body.checks.docker).toStrictEqual({
      ok: false,
      detail: 'docker did not answer the worker',
    });
    expect(body.checks.image).toStrictEqual({ ok: false, detail: 'run pnpm infra:image' });
    expect([DOCKER_UNREACHABLE, IMAGE_MISSING]).toStrictEqual([
      'docker did not answer the worker',
      'run pnpm infra:image',
    ]);
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
    expect(body.checks.db).toStrictEqual({ ok: false, detail: 'ECONNREFUSED' });
    expect(body.checks.redis).toStrictEqual({ ok: false, detail: 'ECONNREFUSED' });
    // Which probe failed, and how it is classified. Two dependencies are probed together, and a
    // line naming neither leaves an operator unable to tell which one to go and look at.
    const logged = harness.doubles
      .logOutput()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toContainEqual(
      expect.objectContaining({ msg: 'health probe failed', probe: 'db', failure: 'ECONNREFUSED' }),
    );
    expect(logged).toContainEqual(
      expect.objectContaining({
        msg: 'health probe failed',
        probe: 'redis',
        failure: 'ECONNREFUSED',
      }),
    );
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
      expect(body.checks.db).toStrictEqual({ ok: false, detail: 'timeout' });
      expect(TIMED_OUT).toBe('timeout');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Reading the heartbeat is bounded the same way: a Redis that accepted the connection and then
   * stopped answering must not stall the route.
   */
  it('leaves no timer behind for a probe that answered', async () => {
    vi.useFakeTimers();
    try {
      const harness = createTestContainer({ now: NOW });
      await writeHeartbeat(harness);

      const body = healthResponse.parse(
        await (await getHealth(harness.container, readRequest('/api/health'))).json(),
      );

      // Every probe answered, so every deadline is disarmed. A timer left armed for each poll of a
      // page that polls every few seconds is a process that never falls idle.
      expect(body.ok).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

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
