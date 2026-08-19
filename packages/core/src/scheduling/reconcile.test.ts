/**
 * Unit tests for the database ↔ Job Scheduler reconciliation plan.
 *
 * Layer: unit.
 * Goal: only genuinely missing or changed schedulers are upserted, every scheduler without an
 * enabled job is removed, the plan is deterministically ordered, and applying it converges.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { reconcile } from './reconcile.js';
import type { ExistingScheduler, ReconcilableJob } from './reconcile.js';

/**
 * Builds a job row with sensible defaults.
 *
 * @param id - Job id, also its scheduler key.
 * @param overrides - Fields to change.
 * @returns A reconcilable job.
 */
function job(id: string, overrides: Partial<ReconcilableJob> = {}): ReconcilableJob {
  return { id, cron: '0 2 * * *', timezone: 'UTC', enabled: true, ...overrides };
}

/**
 * Builds the scheduler that a job would produce, so "in sync" is expressed once.
 *
 * @param source - The job the scheduler was registered for.
 * @param overrides - Fields to change, to express drift.
 * @returns An existing scheduler.
 */
function scheduler(source: ReconcilableJob, overrides: Partial<ExistingScheduler> = {}) {
  return { key: source.id, pattern: source.cron, tz: source.timezone, ...overrides };
}

describe('reconcile', () => {
  /**
   * Nothing on either side is nothing to do; the plan is still a well-formed pair of lists.
   */
  it('produces an empty plan for empty inputs', () => {
    expect(reconcile([], [])).toEqual({ upsert: [], remove: [] });
  });

  /**
   * A job created while Redis was down has no scheduler, which is the case boot reconciliation
   * exists for.
   */
  it('upserts an enabled job that has no scheduler', () => {
    const only = job('a');
    expect(reconcile([only], [])).toEqual({
      upsert: [{ id: 'a', cron: '0 2 * * *', timezone: 'UTC' }],
      remove: [],
    });
  });

  /**
   * An unchanged scheduler is left alone: upserting it would reschedule its next delayed job and
   * push the next tick further out on every worker restart.
   */
  it('leaves an in-sync scheduler untouched', () => {
    const only = job('a');
    expect(reconcile([only], [scheduler(only)])).toEqual({ upsert: [], remove: [] });
  });

  /**
   * Editing the cron or the timezone must reach Redis; both fields are compared, because a
   * timezone-only edit changes the firing instants without changing the pattern.
   */
  it('upserts when the pattern or the timezone drifted', () => {
    const only = job('a');
    expect(reconcile([only], [scheduler(only, { pattern: '0 3 * * *' })]).upsert).toHaveLength(1);
    expect(reconcile([only], [scheduler(only, { tz: 'Europe/Berlin' })]).upsert).toHaveLength(1);
  });

  /**
   * A scheduler whose job row was deleted keeps firing forever unless it is removed.
   */
  it('removes a scheduler with no matching job', () => {
    expect(reconcile([], [{ key: 'ghost', pattern: '0 2 * * *', tz: 'UTC' }])).toEqual({
      upsert: [],
      remove: ['ghost'],
    });
  });

  /**
   * Disabling a job is expressed by removing its scheduler, never by leaving a disabled scheduler
   * in place, so a disabled row with a scheduler is a removal and not an upsert.
   */
  it('removes the scheduler of a disabled job', () => {
    const disabled = job('a', { enabled: false });
    expect(reconcile([disabled], [scheduler(disabled)])).toEqual({ upsert: [], remove: ['a'] });
  });

  /**
   * A disabled job that already has no scheduler produces no work at all.
   */
  it('ignores a disabled job with no scheduler', () => {
    expect(reconcile([job('a', { enabled: false })], [])).toEqual({ upsert: [], remove: [] });
  });

  /**
   * Both lists are sorted by id so two workers booting against the same state issue the same
   * commands in the same order, which makes the plan diffable in logs.
   */
  it('orders both lists deterministically', () => {
    const jobs = [job('c'), job('a'), job('b', { enabled: false })];
    const plan = reconcile(jobs, [
      { key: 'z-ghost' },
      { key: 'b', pattern: '0 2 * * *', tz: 'UTC' },
      { key: 'a-ghost' },
    ]);
    expect(plan.upsert.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(plan.remove).toEqual(['a-ghost', 'b', 'z-ghost']);
  });

  /**
   * A scheduler BullMQ reports without a pattern (a legacy or interval-based entry) differs from
   * every cron job, so it is re-registered rather than assumed compatible.
   */
  it('upserts over a scheduler reported without a pattern', () => {
    const only = job('a');
    expect(reconcile([only], [{ key: 'a' }]).upsert.map((entry) => entry.id)).toEqual(['a']);
  });

  /**
   * The plan is pure: neither input array nor the objects inside them are modified, so the caller
   * may keep using the rows it read from the database.
   */
  it('does not mutate its inputs', () => {
    const jobs = [job('a'), job('b', { enabled: false })];
    const schedulers = [scheduler(jobs[0]!), { key: 'ghost' }];
    const jobsBefore = structuredClone(jobs);
    const schedulersBefore = structuredClone(schedulers);
    reconcile(jobs, schedulers);
    expect(jobs).toEqual(jobsBefore);
    expect(schedulers).toEqual(schedulersBefore);
  });

  /**
   * Applying the plan and reconciling again must be a no-op: convergence in one pass is what lets
   * the worker reconcile on every boot without drifting.
   */
  it('converges after the plan is applied', () => {
    const jobs = [job('a'), job('c', { cron: '0 4 * * *' }), job('d', { enabled: false })];
    const before: ExistingScheduler[] = [
      { key: 'a', pattern: '0 9 * * *', tz: 'UTC' },
      { key: 'd', pattern: '0 2 * * *', tz: 'UTC' },
    ];
    const plan = reconcile(jobs, before);
    const after = before
      .filter((entry) => !plan.remove.includes(entry.key))
      .filter((entry) => !plan.upsert.some((upserted) => upserted.id === entry.key))
      .concat(
        plan.upsert.map((entry) => ({ key: entry.id, pattern: entry.cron, tz: entry.timezone })),
      );
    expect(reconcile(jobs, after)).toEqual({ upsert: [], remove: [] });
    expect(after.map((entry) => entry.key).sort()).toEqual(['a', 'c']);
  });
});
