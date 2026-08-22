/**
 * Unit tests for the run-times update.
 *
 * Layer: unit.
 * Goal: a tick is recorded with the occurrence that follows it; a schedule the parser rejects
 * still records the tick and says which job it could not read; a job deleted while its run is torn
 * down is absorbed and named; and any other failure of the write travels instead of being filed
 * under the schedule.
 * Mocks: `setupProcessorContainer`'s in-memory repositories.
 */
import { describe, expect, it, vi } from 'vitest';

import { seedJob, setupProcessorContainer } from '../testing/index.js';

import { updateRunTimes, writeRunTimes } from './run-times.js';

/** The records the container collected, parsed back from the lines pino wrote. */
function records(logs: string[]): Record<string, unknown>[] {
  return logs.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('updateRunTimes', () => {
  /**
   * The ordinary tick: this run is stamped and the next occurrence is computed from the schedule.
   */
  it('records the tick and the occurrence that follows it', async () => {
    const container = setupProcessorContainer();
    const job = await seedJob(container);

    await updateRunTimes(container, job);

    const updated = await container.repos.scheduledJobs.get(job.id);
    expect(updated?.lastRunAt).toStrictEqual(container.clock.now());
    expect(updated?.nextRunAt).not.toBeNull();
  });

  /**
   * A cron the parser rejects cannot reach the database through the API, but one row that did
   * must not stop every tick of every job. The tick is still recorded, the next occurrence is left
   * unknown, and the line names the job — a warning about "an invalid schedule" with no job on it
   * tells an operator with fifty jobs nothing they can act on.
   */
  it('records the tick and names the job when the schedule cannot be parsed', async () => {
    const container = setupProcessorContainer();
    const job = await seedJob(container, { cron: 'not a cron' });

    await updateRunTimes(container, job);

    const updated = await container.repos.scheduledJobs.get(job.id);
    expect(updated?.lastRunAt).toStrictEqual(container.clock.now());
    expect(updated?.nextRunAt).toBeNull();
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'cannot compute the next run of an invalid schedule',
        jobId: job.id,
      }),
    );
  });

  /**
   * Only an unreadable schedule is absorbed here. A write that failed for its own reasons — a
   * database that is down — has to travel, or a tick would be recorded as successful against a row
   * that was never written and the operator would learn nothing. Rejecting only the first write is
   * what tells the two apart: a branch that swallowed the failure would retry without the next
   * occurrence and report success.
   */
  it('lets a failure that is not the schedule travel', async () => {
    const container = setupProcessorContainer();
    const job = await seedJob(container);
    vi.spyOn(container.repos.scheduledJobs, 'setRunTimes').mockRejectedValueOnce(
      new Error('database is down'),
    );

    await expect(updateRunTimes(container, job)).rejects.toThrow('database is down');
  });
});

describe('writeRunTimes', () => {
  /**
   * The API allows a job to be deleted the moment its run is terminal, which lands inside this
   * teardown. The row that is no longer there is absorbed — and named, because a run-times write
   * that vanished silently would leave nobody able to explain the missing stamp.
   */
  it('absorbs the job being deleted under it, naming it', async () => {
    const container = setupProcessorContainer();
    const job = await seedJob(container);
    await container.repos.scheduledJobs.delete(job.id);

    await expect(
      writeRunTimes(container, job.id, { lastRunAt: container.clock.now() }),
    ).resolves.toBeUndefined();

    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'scheduled job was deleted while its run was being torn down',
        jobId: job.id,
      }),
    );
  });

  /**
   * A row reported missing under some other identifier is not the delete this teardown is willing
   * to absorb: comparing the error type alone would swallow a write that went to the wrong row.
   */
  it('does not absorb a not-found about another job', async () => {
    const container = setupProcessorContainer();
    const job = await seedJob(container);
    const { NotFoundError } = await import('@agent-hangar/core');
    vi.spyOn(container.repos.scheduledJobs, 'setRunTimes').mockRejectedValue(
      new NotFoundError('ScheduledJob', 'some-other-job'),
    );

    await expect(
      writeRunTimes(container, job.id, { lastRunAt: container.clock.now() }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
