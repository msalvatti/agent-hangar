/**
 * Integration tests (@redis) for the Job Scheduler wrappers.
 *
 * Layer: integration.
 * Goal: against a real Redis, an upsert creates exactly one scheduler per job and updating a cron
 * replaces it rather than adding a second, removal deletes it, and a reconciliation plan converges
 * in one application.
 * Mocks: none — needs `REDIS_URL`. Fails loudly when `CI=1` and Redis is unreachable; skips with
 * an instruction locally. Every run uses its own key prefix and obliterates the queue afterwards.
 */
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { reconcile } from '../scheduling/reconcile.ts';
import type { ReconcilableJob } from '../scheduling/reconcile.ts';

import { QUEUE_NAMES } from './contracts.ts';
import { closeConnection, createQueue, createQueueConnection } from './queues.ts';
import { describeRedis, pingOrFail, uniquePrefix } from './redis.integration-helper.ts';
import {
  applyReconcilePlan,
  listSchedulers,
  removeScheduledJob,
  upsertGcScheduler,
  upsertScheduledJob,
} from './schedulers.ts';

/** Wall-clock limit per test; a Redis round trip is fast, a broken one must not hang the run. */
const TEST_TIMEOUT_MS = 30_000;

describeRedis('@redis job schedulers', (url) => {
  const prefix = uniquePrefix();
  let connection: Redis;
  let queue: Queue;

  beforeAll(async () => {
    connection = createQueueConnection(url);
    await pingOrFail(connection, url);
    queue = createQueue(QUEUE_NAMES.scheduledJobs, { connection, prefix });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await closeConnection(connection);
  });

  /**
   * One job means one scheduler, carrying the pattern and timezone it was registered with; a
   * second upsert with a new cron replaces it instead of adding a rival that would double-fire.
   */
  it(
    'creates exactly one scheduler per job and updates it in place',
    async () => {
      await upsertScheduledJob(queue, { id: 'job-a', cron: '*/5 * * * *', timezone: 'UTC' });
      expect(await listSchedulers(queue)).toEqual([
        { key: 'job-a', pattern: '*/5 * * * *', tz: 'UTC' },
      ]);

      await upsertScheduledJob(queue, { id: 'job-a', cron: '0 * * * *', timezone: 'UTC' });
      expect(await listSchedulers(queue)).toEqual([
        { key: 'job-a', pattern: '0 * * * *', tz: 'UTC' },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * Listing is ordered by key regardless of the order Redis reports, and removal deletes the one
   * scheduler it names.
   */
  it(
    'lists schedulers in key order and removes one',
    async () => {
      await upsertScheduledJob(queue, { id: 'job-b', cron: '0 2 * * *', timezone: 'UTC' });
      expect((await listSchedulers(queue)).map((entry) => entry.key)).toEqual(['job-a', 'job-b']);

      await expect(removeScheduledJob(queue, 'job-a')).resolves.toBe(true);
      expect((await listSchedulers(queue)).map((entry) => entry.key)).toEqual(['job-b']);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * Boot reconciliation is the safety net for a Redis that drifted from the database. Applying the
   * plan once must reach the enabled set, and reconciling again must produce nothing — a second
   * pass that still had work to do would re-schedule every job on every restart.
   */
  it(
    'converges in one application and then no-ops',
    async () => {
      await upsertScheduledJob(queue, { id: 'job-d', cron: '0 4 * * *', timezone: 'UTC' });
      const jobs: ReconcilableJob[] = [
        { id: 'job-b', cron: '0 2 * * *', timezone: 'UTC', enabled: true },
        { id: 'job-c', cron: '0 3 * * *', timezone: 'Europe/Berlin', enabled: true },
        { id: 'job-d', cron: '0 4 * * *', timezone: 'UTC', enabled: false },
      ];

      const first = await applyReconcilePlan(queue, reconcile(jobs, await listSchedulers(queue)));
      expect(first).toEqual({ upserted: ['job-c'], removed: ['job-d'] });
      expect((await listSchedulers(queue)).map((entry) => entry.key)).toEqual(['job-b', 'job-c']);

      const second = await applyReconcilePlan(queue, reconcile(jobs, await listSchedulers(queue)));
      expect(second).toEqual({ upserted: [], removed: [] });
      expect((await listSchedulers(queue)).map((entry) => entry.key)).toEqual(['job-b', 'job-c']);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * The collector's scheduler really is registered in Redis but is hidden from the job listing, so
   * reconciliation leaves it alone instead of removing and recreating it on every boot.
   */
  it(
    'registers the collector scheduler without exposing it to reconciliation',
    async () => {
      await upsertGcScheduler(queue);
      const raw = await queue.getJobSchedulers();
      expect(raw.map((entry) => entry.key)).toContain('reap-idle');
      expect((await listSchedulers(queue)).map((entry) => entry.key)).not.toContain('reap-idle');

      const plan = reconcile(
        [
          { id: 'job-b', cron: '0 2 * * *', timezone: 'UTC', enabled: true },
          { id: 'job-c', cron: '0 3 * * *', timezone: 'Europe/Berlin', enabled: true },
        ],
        await listSchedulers(queue),
      );
      expect(plan).toEqual({ upsert: [], remove: [] });
    },
    TEST_TIMEOUT_MS,
  );
});
