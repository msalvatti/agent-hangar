/**
 * Unit tests for the boot-time scheduler reconciliation.
 *
 * Layer: unit.
 * Goal: enabled jobs get a scheduler carrying their cron, timezone and payload; a scheduler with
 * no matching enabled job is removed; the collector's own scheduler is always registered; and a
 * second boot changes nothing it does not have to.
 * Mocks: `createTestContainer`'s recording queues.
 */
import { GC_CRON, GC_SCHEDULER_KEY, JOB_NAMES } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import { reconcileSchedulers } from './scheduler-reconcile.js';
import { createTestContainer } from './testing/index.js';
import type { TestContainer } from './testing/index.js';

/** Seeds a scheduled job. */
async function seedJob(
  container: TestContainer,
  options: { name: string; cron: string; enabled: boolean },
): Promise<string> {
  const job = await container.repos.scheduledJobs.create({
    name: options.name,
    cron: options.cron,
    timezone: 'UTC',
    prompt: 'print date',
    repoUrl: 'https://github.com/octocat/Hello-World',
    branch: 'master',
    enabled: options.enabled,
  });
  return job.id;
}

describe('reconcileSchedulers', () => {
  /**
   * Every enabled job ends up with a scheduler carrying its schedule and the payload the consumer
   * validates, and the collector's own scheduler is registered on the other queue.
   */
  it('registers a scheduler per enabled job and the collector', async () => {
    const container = createTestContainer();
    const first = await seedJob(container, { name: 'nightly', cron: '0 3 * * *', enabled: true });
    await seedJob(container, { name: 'disabled', cron: '0 4 * * *', enabled: false });

    const summary = await reconcileSchedulers(container);

    expect(summary).toEqual({ upserted: 1, removed: 0 });
    expect(container.queues.scheduledJobs.scheduler(first)).toMatchObject({
      pattern: '0 3 * * *',
      tz: 'UTC',
      template: { name: JOB_NAMES.runScheduledJob, data: { jobId: first, trigger: 'SCHEDULE' } },
    });
    expect(container.queues.workspaceGc.scheduler(GC_SCHEDULER_KEY)).toMatchObject({
      pattern: GC_CRON,
      template: { name: JOB_NAMES.reapIdle, data: {} },
    });
  });

  /**
   * A scheduler whose job was deleted or disabled keeps firing until something removes it; that is
   * what makes this a reconciliation rather than a registration.
   */
  it('removes a scheduler with no matching enabled job', async () => {
    const container = createTestContainer();
    await container.queues.scheduledJobs.upsertJobScheduler(
      'gone',
      { pattern: '* * * * *', tz: 'UTC' },
      { name: JOB_NAMES.runScheduledJob, data: { jobId: 'gone', trigger: 'SCHEDULE' } },
    );

    const summary = await reconcileSchedulers(container);

    expect(summary).toEqual({ upserted: 0, removed: 1 });
    expect(container.queues.scheduledJobs.scheduler('gone')).toBeUndefined();
    expect(container.queues.scheduledJobs.removed).toEqual(['gone']);
  });

  /**
   * A second boot must not re-upsert an unchanged scheduler: an upsert reschedules the next
   * delayed job, so a worker that restarts often would push every tick further out.
   */
  it('changes nothing on a second boot', async () => {
    const container = createTestContainer();
    await seedJob(container, { name: 'nightly', cron: '0 3 * * *', enabled: true });
    await reconcileSchedulers(container);

    const summary = await reconcileSchedulers(container);

    expect(summary).toEqual({ upserted: 0, removed: 0 });
  });

  /**
   * A job whose cron was edited is re-registered, because the scheduler in Redis still carries the
   * old pattern.
   */
  it('re-registers a job whose schedule changed', async () => {
    const container = createTestContainer();
    const jobId = await seedJob(container, { name: 'nightly', cron: '0 3 * * *', enabled: true });
    await reconcileSchedulers(container);
    await container.repos.scheduledJobs.update(jobId, { cron: '0 5 * * *' });

    const summary = await reconcileSchedulers(container);

    expect(summary).toEqual({ upserted: 1, removed: 0 });
    expect(container.queues.scheduledJobs.scheduler(jobId)?.pattern).toBe('0 5 * * *');
  });

  /**
   * With no jobs at all the collector is still scheduled: idle workspaces have to be reaped
   * whether or not anything is scheduled.
   */
  it('registers the collector even with no jobs', async () => {
    const container = createTestContainer();

    const summary = await reconcileSchedulers(container);

    expect(summary).toEqual({ upserted: 0, removed: 0 });
    expect(container.queues.workspaceGc.scheduler(GC_SCHEDULER_KEY)).toBeDefined();
    expect(container.logs.join('')).toContain('job schedulers reconciled');
  });
});
