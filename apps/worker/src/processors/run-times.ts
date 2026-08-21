/**
 * When a scheduled job last fired, and when it should fire next.
 *
 * Layer: service (processor).
 *
 * The last step of every tick's teardown, and the one write in it that names a row the run itself
 * does not own. That is what gives it a module: the delivery is over by the time this runs, the
 * job it updates may have been deleted while the container was being destroyed, and neither of
 * those facts belongs in the middle of the consumer that drives the run.
 */
import { InvalidCronError, nextRunAt } from '@agent-hangar/core';
import type { RunTimes, ScheduledJob } from '@agent-hangar/core';

import { isMissingRow } from '../errors.js';

import type { ProcessorDeps } from './types.js';

/**
 * Writes the run times, unless the job has been deleted underneath this teardown.
 *
 * A job deleted while its run was being torn down is not a failure of the teardown. A caller that
 * waits for a run to reach a terminal status and then deletes its job is doing something the API
 * allows — the status is written while the container is still up, and the teardown that follows it
 * destroys the container, marks the workspace `DESTROYED` and lands here — so the delete commits in
 * the middle of it. Treating the row's absence as an error failed the whole delivery over a
 * sequence nothing forbids. There is nothing to record for a job nobody will ask about again, so
 * what is recorded is that there was nothing to record.
 *
 * @param deps - Repositories and logger.
 * @param jobId - The job whose times are being written.
 * @param times - What to store.
 */
export async function writeRunTimes(
  deps: ProcessorDeps,
  jobId: string,
  times: RunTimes,
): Promise<void> {
  try {
    await deps.repos.scheduledJobs.setRunTimes(jobId, times);
  } catch (error) {
    if (!isMissingRow(error, 'ScheduledJob', jobId)) {
      throw error;
    }
    deps.logger.info({ jobId }, 'scheduled job was deleted while its run was being torn down');
  }
}

/**
 * Recomputes when the job should next fire.
 *
 * A cron the parser rejects cannot happen for a row the API validated, but the worker must not
 * crash on one: a single bad row would stop every tick of every job.
 *
 * @param deps - Repositories, clock and logger.
 * @param job - The job definition.
 */
export async function updateRunTimes(deps: ProcessorDeps, job: ScheduledJob): Promise<void> {
  const lastRunAt = deps.clock.now();
  try {
    const next = nextRunAt({ cron: job.cron, timezone: job.timezone }, lastRunAt);
    await writeRunTimes(deps, job.id, { lastRunAt, nextRunAt: next });
  } catch (error) {
    if (!(error instanceof InvalidCronError)) {
      throw error;
    }
    deps.logger.warn({ jobId: job.id }, 'cannot compute the next run of an invalid schedule');
    await writeRunTimes(deps, job.id, { lastRunAt });
  }
}
