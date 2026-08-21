/**
 * Which run a delivery of `run-scheduled-job` is entitled to drive.
 *
 * Layer: service (processor).
 *
 * The consumer's other half runs a tick: one fresh workspace, one execution, one teardown. This
 * half decides, before any of that, *which* `JobRun` row the delivery is about — and it is where
 * every way of getting that wrong is answered. A manual run already has a row and a browser
 * attached to its stream, so the delivery adopts it rather than inserting a rival nothing is
 * watching. A delivery naming a row that belongs to another job, or to a run that already started,
 * is refused outright. A tick that overlaps a run still executing is recorded rather than queued,
 * because queueing would let a slow job accumulate one container per tick. And a run whose worker
 * died is closed out first, so its successor runs instead of skipping for ever behind a
 * predecessor that will never finish.
 *
 * What marks that last case is `stalledCounter`, not `attemptsMade`: BullMQ's stalled script
 * increments a counter of its own (`stc` on the job hash) and never touches the attempt count, and
 * nothing here configures `attempts`, so a job that came back from the stalled set still reports
 * zero attempts. The two are only ever one delivery apart because the queue runs with a
 * concurrency of one and an instance runs a single worker: the redelivery waits for the slot the
 * original occupies, so by the time it is read the original is genuinely gone. A second worker
 * process would need the claim the consumer keeps in memory to live in Postgres or Redis instead.
 */
import { isLiveWorkspaceStatus } from '@agent-hangar/core';
import type { JobRun, RunScheduledJobPayload, ScheduledJob } from '@agent-hangar/core';

import type { CancellationWatch } from './cancellation.js';
import {
  OVERLAP_SKIP_CODE,
  STALLED_RUN_CODE,
  STALLED_RUN_MESSAGE,
  STALLED_RUN_REASON,
} from './constants.js';
import { endUnstartedRun, failRun } from './run-outcome.js';
import type { ProcessorDeps } from './types.js';

/**
 * Raised when a delivery names a run row it is not entitled to drive.
 *
 * The delivery is failed rather than quietly re-pointed at a fresh row: a delivery naming a run
 * that belongs elsewhere is a bug or a stale message, and both are worth seeing.
 */
export class IneligibleRunError extends Error {
  /**
   * @param runId - The run the delivery named.
   * @param jobId - The job the delivery belongs to.
   */
  constructor(runId: string, jobId: string) {
    super(`run ${runId} is not an open manual run of job ${jobId}`);
    this.name = 'IneligibleRunError';
  }
}

/**
 * Records the tick that was dropped because the previous run is still executing.
 *
 * It goes through the same terminal path as every other run that never started, terminal event
 * included — see {@link endUnstartedRun} for why a Stop that already arrived outranks the overlap
 * as the record, and for why the event matters.
 *
 * The run times are deliberately left alone: the run that is still executing owns them, and
 * moving `nextRunAt` here would report a schedule the job is not following.
 *
 * @param deps - Publisher, repositories and logger.
 * @param job - The job definition.
 * @param run - The run being dropped.
 * @param reason - Why it was dropped.
 * @param watch - The run's cancellation subscription, open since before the overlap was decided.
 */
export async function recordSkippedTick(
  deps: ProcessorDeps,
  job: ScheduledJob,
  run: JobRun,
  reason: string,
  watch: CancellationWatch,
): Promise<void> {
  // True of both outcomes: the tick was dropped and nothing was executed for it. Only which
  // terminal status the row carries depends on whether the user had already asked to stop.
  deps.logger.info({ jobId: job.id, runId: run.id }, 'scheduled run skipped');
  await endUnstartedRun(deps, run.id, watch, OVERLAP_SKIP_CODE, reason);
}

/**
 * Reports whether a delivery may take over the run row it names.
 *
 * The API opens a manual run as `QUEUED` and answers the request with its id, so that is the one
 * shape a delivery is entitled to adopt. Anything else — a run of another job, a scheduled run, a
 * run that already started or already finished — means the delivery is stale or mismatched, and
 * writing to that row would overwrite another run's record and hang a workspace and a tool log
 * off it.
 *
 * @param run - The row the delivery named.
 * @param jobId - The job the delivery belongs to.
 * @returns `true` when the row is this delivery's to drive.
 */
function mayAdopt(run: JobRun, jobId: string): boolean {
  return run.jobId === jobId && run.trigger === 'MANUAL' && run.status === 'QUEUED';
}

/**
 * Closes the manual run a delivery already owns when its job cannot be run.
 *
 * A manual run has a row before the worker ever sees the delivery, and a browser watching that
 * row's stream. Returning without touching it — because the job was disabled or deleted in the
 * meantime — would leave a `QUEUED` run nothing will ever finish and a page waiting for an event
 * nobody is going to send. A scheduled tick carries no row and needs none: there is nothing to
 * close and nothing watching.
 *
 * The same eligibility rule as adoption applies, so a stale delivery cannot terminalise a row that
 * belongs to another job or to a run that has already started. The Stop the user may have pressed
 * in the meantime is honoured only once that rule has passed, for the same reason: a cancellation
 * aimed at this run is no licence to write a terminal status onto somebody else's row.
 *
 * The early watch stands in for the delivery's `runId` here. The two exist together or not at all —
 * the consumer opens the watch on `payload.runId` and only when it is present — so its absence is
 * what says "this delivery carries no row to close", and its key is that row. Reading the id off
 * the watch also makes it impossible to close out a run the watch does not cover.
 *
 * @param deps - Publisher and repositories.
 * @param payload - The delivery.
 * @param earlyWatch - The manual run's subscription, or `null` for a tick.
 * @param code - Machine-readable failure code.
 * @param message - What the user is told.
 */
export async function closeUnrunnableRun(
  deps: ProcessorDeps,
  payload: RunScheduledJobPayload,
  earlyWatch: CancellationWatch | null,
  code: string,
  message: string,
): Promise<void> {
  if (earlyWatch === null) {
    return;
  }
  const run = await deps.repos.jobRuns.get(earlyWatch.key);
  if (run === null || !mayAdopt(run, payload.jobId)) {
    return;
  }
  await endUnstartedRun(deps, run.id, earlyWatch, code, message);
}

/**
 * Destroys the container an abandoned run left behind.
 *
 * The row is re-read rather than trusted from the run: a workspace already closed out — by a
 * teardown that got far enough, or by an earlier recovery — must not be destroyed twice or walked
 * back out of a terminal status the lifecycle forbids leaving.
 *
 * A live row is this run's unless it is `STOPPING`, the one live status a competitor can put it in:
 * a teardown that reached it has committed to destroying that container, so doing it here too is the
 * overwrite the conditional take prevents. A job workspace serves one run, so the rest is this run's.
 *
 * @param deps - Runner, repositories and logger.
 * @param workspaceId - The workspace the abandoned run was using.
 */
async function destroyAbandonedWorkspace(deps: ProcessorDeps, workspaceId: string): Promise<void> {
  const workspace = await deps.repos.workspaces.get(workspaceId);
  if (
    workspace === null ||
    !isLiveWorkspaceStatus(workspace.status) ||
    workspace.status === 'STOPPING'
  ) {
    return;
  }
  try {
    await deps.runner.destroy({
      workspaceId: workspace.id,
      runnerRef: workspace.runnerRef ?? '',
    });
  } catch (error) {
    deps.logger.error(
      { err: error, workspaceId },
      'destroying the workspace of an abandoned run failed',
    );
  }
  await deps.repos.workspaces.setStatus(workspace.id, 'DESTROYED', {
    failureReason: STALLED_RUN_REASON,
  });
}

/**
 * Closes out the run a dead worker left behind, so this delivery can run its tick.
 *
 * The terminal event goes out like any other failure: a manual run may still have a browser
 * attached to its stream from before the worker died.
 *
 * It stays a failure even while this delivery holds an open cancellation watch, because that watch
 * belongs to a different run. The abandoned row is a predecessor of the job, never the run this
 * delivery drives, and the only subscription that was ever listening for its Stop died with the
 * worker that opened it. Recording it as cancelled would claim a request nothing here received.
 *
 * @param deps - Runner, publisher, repositories and logger.
 * @param abandoned - The run found still executing, whose executor is gone.
 */
async function recoverAbandonedRun(deps: ProcessorDeps, abandoned: JobRun): Promise<void> {
  deps.logger.warn(
    { jobId: abandoned.jobId, runId: abandoned.id },
    'recovering a run whose worker stopped while it was executing',
  );
  if (abandoned.workspaceId !== null) {
    await destroyAbandonedWorkspace(deps, abandoned.workspaceId);
  }
  await failRun(deps, abandoned.id, STALLED_RUN_CODE, STALLED_RUN_MESSAGE);
}

/**
 * Tells a run that is genuinely still executing apart from one a dead worker abandoned.
 *
 * @param deps - The processor's collaborators.
 * @param jobId - The job this delivery belongs to.
 * @param stalledCounter - How many times BullMQ recovered this delivery from the stalled set.
 * @returns The run that is really still running, or `null` — either because there is none, or
 *   because the one that was there has just been closed out.
 */
export async function resolveRunningRun(
  deps: ProcessorDeps,
  jobId: string,
  stalledCounter: number,
): Promise<JobRun | null> {
  const running = await deps.repos.jobRuns.findRunningByJob(jobId);
  if (running === null || stalledCounter === 0) {
    return running;
  }
  await recoverAbandonedRun(deps, running);
  return null;
}

/**
 * Finds the run this delivery belongs to, or opens one.
 *
 * A manual run already has its row — the API created it so it could answer with an id the browser
 * subscribes to — and inserting a second one would leave that subscription watching a stream
 * nothing writes to. A row that has since vanished is treated as a tick, so a delivery is never
 * dropped for want of a record.
 *
 * @param deps - Repositories and logger.
 * @param job - The job definition.
 * @param payload - The delivery.
 * @param scheduledFor - The tick this delivery belongs to.
 * @returns The run to record against.
 * @throws IneligibleRunError When the delivery names a row it may not adopt.
 */
export async function openRun(
  deps: ProcessorDeps,
  job: ScheduledJob,
  payload: RunScheduledJobPayload,
  scheduledFor: Date,
): Promise<JobRun> {
  if (payload.runId !== undefined) {
    const adopted = await deps.repos.jobRuns.get(payload.runId);
    if (adopted !== null) {
      if (!mayAdopt(adopted, job.id)) {
        deps.logger.error(
          { jobId: job.id, runId: payload.runId },
          'delivery names a run it may not adopt',
        );
        throw new IneligibleRunError(payload.runId, job.id);
      }
      return adopted;
    }
    deps.logger.warn({ jobId: job.id, runId: payload.runId }, 'run to adopt is gone');
  }
  return deps.repos.jobRuns.create({
    jobId: job.id,
    trigger: payload.trigger,
    model: deps.config.OPENAI_MODEL,
    scheduledFor,
  });
}
