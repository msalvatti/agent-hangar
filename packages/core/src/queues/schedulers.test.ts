/**
 * Unit tests for the Job Scheduler wrappers.
 *
 * Layer: unit.
 * Goal: a scheduler is upserted under the job's own id with the contract job name and payload,
 * listing hides the collector's scheduler and normalises absent fields, and applying a plan issues
 * the calls in a deterministic order.
 * Mocks: an in-memory `SchedulerQueue` that records every call; no Redis.
 */
import { describe, expect, it } from 'vitest';

import { GC_CRON, GC_SCHEDULER_KEY } from '../scheduling/keys.ts';
import type { ReconcilePlan } from '../scheduling/types.ts';

import { JOB_NAMES } from './contracts.ts';
import {
  applyReconcilePlan,
  listSchedulers,
  removeScheduledJob,
  upsertGcScheduler,
  upsertScheduledJob,
} from './schedulers.ts';
import type { SchedulerQueue } from './schedulers.ts';

/** One recorded call against the fake queue. */
type RecordedCall =
  | { kind: 'upsert'; key: string; repeat: { pattern: string; tz?: string }; template: unknown }
  | { kind: 'remove'; key: string };

/** A `SchedulerQueue` backed by a map, recording every call in order. */
class FakeSchedulerQueue implements SchedulerQueue {
  readonly calls: RecordedCall[] = [];
  private readonly stored = new Map<
    string,
    { pattern?: string | null | undefined; tz?: string | null | undefined }
  >();

  /**
   * @param initial - Schedulers that already exist, as BullMQ would report them.
   */
  constructor(initial: { key: string; pattern?: string | null; tz?: string | null }[] = []) {
    for (const entry of initial) {
      this.stored.set(entry.key, { pattern: entry.pattern, tz: entry.tz });
    }
  }

  /**
   * @param key - Scheduler key.
   * @param repeat - Repeat options.
   * @param template - Job template.
   * @returns Nothing of interest; BullMQ returns the next delayed job.
   */
  upsertJobScheduler(
    key: string,
    repeat: { pattern: string; tz?: string },
    template: { name: string; data: unknown },
  ): Promise<unknown> {
    this.calls.push({ kind: 'upsert', key, repeat, template });
    this.stored.set(key, { pattern: repeat.pattern, tz: repeat.tz });
    return Promise.resolve(undefined);
  }

  /**
   * @param key - Scheduler key.
   * @returns Whether a scheduler existed under that key.
   */
  removeJobScheduler(key: string): Promise<boolean> {
    this.calls.push({ kind: 'remove', key });
    return Promise.resolve(this.stored.delete(key));
  }

  /** @returns Every stored scheduler, in insertion order. */
  getJobSchedulers(): Promise<
    { key: string; pattern?: string | null | undefined; tz?: string | null | undefined }[]
  > {
    return Promise.resolve(
      [...this.stored.entries()].map(([key, value]) => ({
        key,
        pattern: value.pattern,
        tz: value.tz,
      })),
    );
  }
}

describe('upsertScheduledJob', () => {
  /**
   * The scheduler key is the job id and the template carries the contract job name plus a
   * SCHEDULE-triggered payload, which is what the worker matches on when the tick arrives.
   */
  it('registers a scheduler under the job id', async () => {
    const queue = new FakeSchedulerQueue();
    await upsertScheduledJob(queue, { id: 'job-1', cron: '0 2 * * *', timezone: 'UTC' });
    expect(queue.calls).toEqual([
      {
        kind: 'upsert',
        key: 'job-1',
        repeat: { pattern: '0 2 * * *', tz: 'UTC' },
        template: {
          name: JOB_NAMES.runScheduledJob,
          data: { jobId: 'job-1', trigger: 'SCHEDULE' },
        },
      },
    ]);
  });

  /**
   * Because the key is the job id, editing a schedule updates the one scheduler the job owns
   * rather than leaving the old one firing beside the new.
   */
  it('is idempotent per job', async () => {
    const queue = new FakeSchedulerQueue();
    await upsertScheduledJob(queue, { id: 'job-1', cron: '0 2 * * *', timezone: 'UTC' });
    await upsertScheduledJob(queue, { id: 'job-1', cron: '0 3 * * *', timezone: 'UTC' });
    expect(await listSchedulers(queue)).toEqual([
      { key: 'job-1', pattern: '0 3 * * *', tz: 'UTC' },
    ]);
  });

  /**
   * The payload is validated before the call, so a scheduler can never be registered with a
   * template the worker will refuse to parse.
   */
  it('rejects an empty job id before calling the queue', async () => {
    const queue = new FakeSchedulerQueue();
    await expect(
      upsertScheduledJob(queue, { id: '', cron: '0 2 * * *', timezone: 'UTC' }),
    ).rejects.toThrow();
    expect(queue.calls).toEqual([]);
  });
});

describe('removeScheduledJob', () => {
  /**
   * Disabling a job removes its scheduler, and the queue's answer tells the caller whether there
   * was one to remove.
   */
  it('reports whether a scheduler existed', async () => {
    const queue = new FakeSchedulerQueue([{ key: 'job-1', pattern: '0 2 * * *', tz: 'UTC' }]);
    await expect(removeScheduledJob(queue, 'job-1')).resolves.toBe(true);
    await expect(removeScheduledJob(queue, 'job-1')).resolves.toBe(false);
  });
});

describe('listSchedulers', () => {
  /**
   * The collector's scheduler belongs to no job, so a reconciler that saw it would remove it on
   * every boot and immediately recreate it.
   */
  it('hides the collector scheduler', async () => {
    const queue = new FakeSchedulerQueue([
      { key: GC_SCHEDULER_KEY, pattern: GC_CRON },
      { key: 'job-1', pattern: '0 2 * * *', tz: 'UTC' },
    ]);
    expect(await listSchedulers(queue)).toEqual([
      { key: 'job-1', pattern: '0 2 * * *', tz: 'UTC' },
    ]);
  });

  /**
   * BullMQ omits fields it never stored and can report them as null; both become `undefined` so
   * the reconciler compares against one shape.
   */
  it('normalises absent fields and sorts by key', async () => {
    const queue = new FakeSchedulerQueue([{ key: 'z', pattern: null, tz: null }, { key: 'a' }]);
    expect(await listSchedulers(queue)).toEqual([
      { key: 'a', pattern: undefined, tz: undefined },
      { key: 'z', pattern: undefined, tz: undefined },
    ]);
  });
});

describe('applyReconcilePlan', () => {
  /**
   * Every upsert runs before every removal, in the plan's order, so a failure halfway through
   * leaves a state the next boot converges from rather than an arbitrary one.
   */
  it('upserts then removes, in order', async () => {
    const queue = new FakeSchedulerQueue([{ key: 'stale', pattern: '0 1 * * *', tz: 'UTC' }]);
    const plan: ReconcilePlan = {
      upsert: [
        { id: 'job-a', cron: '0 2 * * *', timezone: 'UTC' },
        { id: 'job-b', cron: '0 3 * * *', timezone: 'Europe/Berlin' },
      ],
      remove: ['stale'],
    };
    await expect(applyReconcilePlan(queue, plan)).resolves.toEqual({
      upserted: ['job-a', 'job-b'],
      removed: ['stale'],
    });
    expect(queue.calls.map((call) => [call.kind, call.key])).toEqual([
      ['upsert', 'job-a'],
      ['upsert', 'job-b'],
      ['remove', 'stale'],
    ]);
  });

  /**
   * An empty plan is the steady state a converged boot reaches, and it must issue no calls at all.
   */
  it('issues no calls for an empty plan', async () => {
    const queue = new FakeSchedulerQueue();
    await expect(applyReconcilePlan(queue, { upsert: [], remove: [] })).resolves.toEqual({
      upserted: [],
      removed: [],
    });
    expect(queue.calls).toEqual([]);
  });
});

describe('upsertGcScheduler', () => {
  /**
   * The collector runs on its own key with no timezone: a five-minute interval means the same
   * thing everywhere, and giving it a zone would make it drift across daylight-saving switches.
   */
  it('registers the collector scheduler', async () => {
    const queue = new FakeSchedulerQueue();
    await upsertGcScheduler(queue);
    expect(queue.calls).toEqual([
      {
        kind: 'upsert',
        key: GC_SCHEDULER_KEY,
        repeat: { pattern: GC_CRON },
        template: { name: JOB_NAMES.reapIdle, data: {} },
      },
    ]);
  });
});
