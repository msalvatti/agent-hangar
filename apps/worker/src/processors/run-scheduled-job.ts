/**
 * The `run-scheduled-job` consumer: one cron tick, one fresh workspace, one recorded run.
 *
 * Layer: service (processor).
 *
 * Two guarantees shape the whole file. Every run gets its own container and that container is
 * destroyed in a `finally`, whatever happened — a job that leaked one workspace per tick would eat
 * the machine within a day. And a tick that fires while the previous run is *still executing* is
 * recorded as a failed run rather than queued, because queueing would let a slow job accumulate
 * exactly those containers.
 *
 * The run takes its own workspace with a conditional write, from `READY` and nothing else. A job
 * workspace is created for one run and destroyed with it, so it is never legitimately free — but
 * the idle collector cannot see that: its clock is `lastActiveAt`, which is stamped when the row is
 * inserted and never bumped for a job workspace, so provisioning that outlives the TTL leaves the
 * row eligible the moment it turns `READY`. The collector runs on its own queue and can therefore
 * take it inside this process, not merely across workers. Losing that write ends the run with a
 * reason of its own rather than an exec into a container somebody else is removing.
 *
 * The second guarantee is about a live predecessor, not a dead one, and the difference decides
 * whether a crash is survivable. A worker that dies mid-run leaves its `JobRun` in `RUNNING` and
 * its workspace in `BUSY`, and nothing else in the system reclaims either — the collector
 * reconciles only `READY` and `STOPPING` rows, the idle selector takes only `READY`, and orphan
 * reconciliation correctly leaves a container alone while a live row points at it. Treating that
 * abandoned row as an overlap would make every later tick of the job skip for ever and leak one
 * container per crash, so a redelivery closes its predecessor out first and then runs the tick.
 *
 * What marks a redelivery is `stalledCounter`, not `attemptsMade`: BullMQ's stalled script
 * increments a counter of its own (`stc` on the job hash) and never touches the attempt count, and
 * nothing here configures `attempts`, so a job that came back from the stalled set still reports
 * zero attempts. The two are only ever one delivery apart because the queue runs with a
 * concurrency of one and an instance runs a single worker: the redelivery waits for the slot the
 * original occupies, so by the time it is read the original is genuinely gone. A second worker
 * process would need the claim this lane keeps in memory to live in Postgres or Redis instead.
 */
import {
  buildJobTurnRequest,
  decideOverlap,
  defaultWorkBranch,
  InvalidCronError,
  isLiveWorkspaceStatus,
  isTerminalRunStatus,
  JOB_WORK_BRANCH_PREFIX,
  nextRunAt,
  runScheduledJobPayload,
} from '@agent-hangar/core';
import type { AgentEvent, JobRun, ScheduledJob, WorkspaceHandle } from '@agent-hangar/core';
import { z } from 'zod';

import { openCancellationWatch } from './cancellation.js';
import type { CancellationWatch } from './cancellation.js';
import { NO_USAGE, STALLED_RUN_REASON, WORKER_ERROR_PREFIX } from './constants.js';
import { buildTurnInstructions } from './instructions.js';
import { provisionWorkspace } from './provision-workspace.js';
import { formatRunError, publishCancellation, publishFailure } from './run-outcome.js';
import { createToolCallRecorder } from './tool-call-recorder.js';
import type { ToolCallRecorder } from './tool-call-recorder.js';
import { executeRuntimeTurn } from './turn-executor.js';
import type { TurnSink, UnreportedOutcome } from './turn-executor.js';
import type { ProcessorDeps, ProcessorJob } from './types.js';

/**
 * The delivery this consumer reads.
 *
 * `runId` is present only on a manual run: the API answers the request with the id of the `JobRun`
 * it created, and the browser opens that run's event stream straight away — so adopting the row
 * rather than inserting a second one is what keeps the page watching a stream something writes to.
 * A scheduled tick carries no id and the row is created when the tick fires. The field is spelled
 * here until the shared queue contract carries it.
 */
const scheduledDeliveryPayload = runScheduledJobPayload.extend({
  runId: z.string().min(1).optional(),
});

/** A delivery of `run-scheduled-job`. */
export type ScheduledDelivery = z.infer<typeof scheduledDeliveryPayload>;

/** Failure code recorded on a tick dropped because the previous run was still executing. */
export const OVERLAP_SKIP_CODE = 'overlapping_run';

/** Failure code recorded on a run whose worker died while it was executing. */
export const STALLED_RUN_CODE = 'stalled_run';

/** What the user is told about a run no worker is driving any more. */
export const STALLED_RUN_MESSAGE =
  'The worker stopped while this run was executing; its workspace has been reclaimed.';

/** Failure code recorded on a run whose workspace was taken before it could be used. */
export const WORKSPACE_RECLAIMED_CODE = 'workspace_reclaimed';

/** What the user is told when the collector took the run's workspace before the run started. */
export const WORKSPACE_RECLAIMED_MESSAGE =
  'This run lost its workspace before it could start; the next tick creates a fresh one.';

/** Failure code recorded on a manual run whose job no longer exists. */
export const JOB_MISSING_CODE = 'job_not_found';

/** What the user is told when the job was deleted between the request and the run. */
export const JOB_MISSING_MESSAGE = 'This scheduled job no longer exists.';

/** Failure code recorded on a manual run whose job was disabled before it started. */
export const JOB_DISABLED_CODE = 'job_disabled';

/** What the user is told when the job was disabled between the request and the run. */
export const JOB_DISABLED_MESSAGE = 'This scheduled job is disabled; enable it and run it again.';

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

/** What the run's workspace is torn down with. */
interface Teardown {
  runId: string;
  handle: WorkspaceHandle | null;
  workspaceId: string | null;
  job: ScheduledJob;
}

/**
 * Records a run as failed and ends its event stream.
 *
 * @param deps - Publisher and repositories.
 * @param runId - The run.
 * @param code - Machine-readable failure code.
 * @param message - Human-readable detail; already safe to persist.
 */
async function failRun(
  deps: ProcessorDeps,
  runId: string,
  code: string,
  message: string,
): Promise<void> {
  await publishFailure(deps, runId, code, message);
  await deps.repos.jobRuns.finish(runId, {
    status: 'FAILED',
    usage: NO_USAGE,
    error: formatRunError(code, message),
  });
}

/**
 * Records a run as cancelled and ends its event stream.
 *
 * @param deps - Publisher and repositories.
 * @param runId - The run.
 */
async function cancelRun(deps: ProcessorDeps, runId: string): Promise<void> {
  await publishCancellation(deps, runId);
  await deps.repos.jobRuns.finish(runId, { status: 'CANCELLED', usage: NO_USAGE });
}

/**
 * Ends a run that never started: as the cancellation the user asked for when one arrived, and
 * otherwise as the failure that made the delivery unrunnable.
 *
 * Both facts can hold of the same delivery. The user pressed Stop — and `POST /api/runs/:id/cancel`
 * answered `202`, which is a promise about this very row — while the delivery was independently
 * going nowhere: the job was deleted, the job was disabled, the previous run is still executing, or
 * the workspace could not be provisioned. Only one record gets written, and it is `CANCELLED`.
 *
 * The case for `FAILED` is not empty: the run could not have proceeded whatever the user did, and
 * the reason is operationally interesting. It loses on two counts. The `202` told the browser this
 * run was being stopped, so a row that then reads `FAILED` makes the API a liar about the one thing
 * the user was waiting to see. And the reason is not lost by cancelling — the worker log already
 * carries it, addressed to the operator who wants it, and a provisioning failure has written itself
 * onto the workspace row as well. What `FAILED` would lose is the user's own instruction, which
 * nothing else records anywhere.
 *
 * Either way exactly one terminal event goes out, published before the row is finished: the manual
 * run's browser is attached to that stream, and a run that ends without a terminal event leaves the
 * page waiting for something nobody is going to send.
 *
 * @param deps - Publisher and repositories.
 * @param runId - The run.
 * @param watch - The run's own cancellation subscription.
 * @param code - Machine-readable failure code, recorded when no cancellation arrived.
 * @param message - Human-readable detail, recorded when no cancellation arrived.
 */
async function endUnstartedRun(
  deps: ProcessorDeps,
  runId: string,
  watch: CancellationWatch,
  code: string,
  message: string,
): Promise<void> {
  if (watch.requested()) {
    await cancelRun(deps, runId);
    return;
  }
  await failRun(deps, runId, code, message);
}

/**
 * Writes the outcome for a run whose runtime never reported one.
 *
 * @param deps - Publisher and repositories.
 * @param runId - The run.
 * @param outcome - What the executor observed.
 */
async function closeOutRun(
  deps: ProcessorDeps,
  runId: string,
  outcome: UnreportedOutcome,
): Promise<void> {
  if (outcome.terminal === 'cancelled') {
    await cancelRun(deps, runId);
    return;
  }
  await failRun(deps, runId, outcome.error.code, outcome.error.message);
}

/**
 * Writes the outcome the runtime reported.
 *
 * @param deps - Repositories.
 * @param runId - The run.
 * @param event - A terminal event, already redacted.
 * @param steps - Highest step the runtime reached, for the outcomes that report no usage.
 */
async function persistRunOutcome(
  deps: ProcessorDeps,
  runId: string,
  event: Extract<AgentEvent, { type: 'turn.completed' | 'turn.failed' | 'turn.cancelled' }>,
  steps: number,
): Promise<void> {
  if (event.type === 'turn.completed') {
    await deps.repos.jobRuns.finish(runId, {
      status: 'SUCCEEDED',
      output: event.finalMessage,
      usage: {
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        stepCount: event.steps,
      },
    });
    return;
  }
  if (event.type === 'turn.failed') {
    await deps.repos.jobRuns.finish(runId, {
      status: 'FAILED',
      usage: { ...NO_USAGE, stepCount: steps },
      error: formatRunError(event.error.code, event.error.message),
    });
    return;
  }
  await deps.repos.jobRuns.finish(runId, {
    status: 'CANCELLED',
    usage: { ...NO_USAGE, stepCount: steps },
  });
}

/**
 * Builds the persistence half of a run's event stream.
 *
 * A run has no chat, so nothing becomes a message: the final answer is the run's `output` and the
 * tool calls are its log.
 *
 * @param deps - Repositories.
 * @param runId - The run.
 * @param recorder - Tool-call bookkeeping.
 * @returns The sink.
 */
function makeJobRunSink(deps: ProcessorDeps, runId: string, recorder: ToolCallRecorder): TurnSink {
  let steps = 0;
  return {
    async onEvent(event: AgentEvent): Promise<void> {
      switch (event.type) {
        case 'step.started':
          steps = Math.max(steps, event.step);
          break;
        case 'tool.call':
          await recorder.start(event);
          break;
        case 'tool.output.delta':
          recorder.append(event);
          break;
        case 'tool.result':
          await recorder.finish(event);
          break;
        case 'turn.completed':
        case 'turn.failed':
        case 'turn.cancelled':
          await persistRunOutcome(deps, runId, event, steps);
          break;
        case 'turn.started':
        case 'prepare.progress':
        case 'prepare.done':
        case 'assistant.delta':
        case 'assistant.message':
        case 'git.pushed':
        case 'heartbeat':
        case 'protocol.error':
          // Published for the live view; a run's durable record is its output and its tool log.
          break;
      }
    },
  };
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
async function updateRunTimes(deps: ProcessorDeps, job: ScheduledJob): Promise<void> {
  const lastRunAt = deps.clock.now();
  try {
    const next = nextRunAt({ cron: job.cron, timezone: job.timezone }, lastRunAt);
    await deps.repos.scheduledJobs.setRunTimes(job.id, { lastRunAt, nextRunAt: next });
  } catch (error) {
    if (!(error instanceof InvalidCronError)) {
      throw error;
    }
    deps.logger.warn({ jobId: job.id }, 'cannot compute the next run of an invalid schedule');
    await deps.repos.scheduledJobs.setRunTimes(job.id, { lastRunAt });
  }
}

/**
 * Destroys the run's workspace and leaves nothing half-written, whatever happened above.
 *
 * The status write is unconditional, and that is not an oversight. `teardown.workspaceId` is
 * filled only once the run has taken the row `BUSY`, and `BUSY` is a status no other writer acts
 * on: the idle selector and a teardown take only `READY`, the reconciliation takes `READY` or
 * `STOPPING`, and boot recovery takes only `STOPPING`. There is nobody to lose a race to.
 *
 * @param deps - Runner, repositories and logger.
 * @param teardown - The run, its container and the job it belongs to.
 */
async function teardownRun(deps: ProcessorDeps, teardown: Teardown): Promise<void> {
  if (teardown.handle !== null) {
    try {
      await deps.runner.destroy(teardown.handle);
    } catch (error) {
      deps.logger.error(
        { err: error, workspaceId: teardown.handle.workspaceId },
        'destroying a run workspace failed',
      );
    }
  }
  if (teardown.workspaceId !== null) {
    await deps.repos.workspaces.setStatus(teardown.workspaceId, 'DESTROYED');
  }
  const run = await deps.repos.jobRuns.get(teardown.runId);
  if (run !== null && !isTerminalRunStatus(run.status)) {
    await deps.repos.jobRuns.finish(teardown.runId, {
      status: 'FAILED',
      usage: NO_USAGE,
      error: `${WORKER_ERROR_PREFIX}: the worker stopped before the run finished`,
    });
  }
  await updateRunTimes(deps, teardown.job);
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
async function recordSkippedTick(
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
async function closeUnrunnableRun(
  deps: ProcessorDeps,
  payload: ScheduledDelivery,
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
 * Past that re-read the write is unconditional, and safely so: a run records its `workspaceId`
 * only after taking the row `BUSY`, so a row named here is `BUSY` or already terminal, and the
 * early return covers terminal. Nothing else writes a `BUSY` row.
 *
 * @param deps - Runner, repositories and logger.
 * @param workspaceId - The workspace the abandoned run was using.
 */
async function destroyAbandonedWorkspace(deps: ProcessorDeps, workspaceId: string): Promise<void> {
  const workspace = await deps.repos.workspaces.get(workspaceId);
  if (workspace === null || !isLiveWorkspaceStatus(workspace.status)) {
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
async function resolveRunningRun(
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
async function openRun(
  deps: ProcessorDeps,
  job: ScheduledJob,
  payload: ScheduledDelivery,
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

/**
 * Runs the prepared run to completion inside its own workspace.
 *
 * The prompt names the branch the request carries, derived by the same function the request
 * builder uses. Naming the job's own branch instead would tell the agent to push to the branch
 * the next sentence of the prompt forbids it to push to.
 *
 * @param deps - The processor's collaborators.
 * @param job - The job definition.
 * @param teardown - Filled in as the workspace appears, so the `finally` can tear it down; also
 *   names the run.
 * @param watch - The cancellation subscription opened before the workspace was provisioned.
 * @throws Error When the Docker daemon is unreachable, so BullMQ retries.
 */
async function runInFreshWorkspace(
  deps: ProcessorDeps,
  job: ScheduledJob,
  teardown: Teardown,
  watch: CancellationWatch,
): Promise<void> {
  const { runId } = teardown;
  const provisioned = await provisionWorkspace(deps, {
    kind: 'JOB',
    jobRunId: runId,
    repoUrl: job.repoUrl,
    branch: job.branch,
  });
  if (!provisioned.ok) {
    // Provisioning is the slow part the user is watching, so it is also where Stop is pressed. A
    // cancellation that arrives while the clone succeeds is honoured by the executor, which seeds
    // its state from this same watch; one that arrives while the clone fails is honoured here, so
    // the two halves of the window agree on what the record says.
    await endUnstartedRun(deps, runId, watch, provisioned.reason, provisioned.message);
    return;
  }
  // Taking the workspace is a conditional write for the same reason it is on the chat path, and
  // this run is more exposed than a turn is: a job workspace's idle clock is stamped when the row
  // is inserted and never bumped again — only a chat turn calls `markActive` — so provisioning
  // that outlives the TTL leaves the row idle-eligible the instant it turns `READY`. The collector
  // can then take it in the gap before this line, on its own queue, in this very process. Writing
  // `BUSY` unconditionally would put the row back over a teardown that had already committed to
  // destroying the container, and the run would exec into a container being removed underneath it.
  const busy = await deps.repos.workspaces.claimStatus(provisioned.workspace.id, 'READY', 'BUSY');
  if (busy === null) {
    // The teardown that won owns the container and the row; racing it with this run's own teardown
    // would destroy the same container twice, so `teardown` is deliberately left unfilled.
    deps.logger.warn(
      { runId, workspaceId: provisioned.workspace.id },
      'the workspace this run provisioned was reclaimed before it could be used',
    );
    await endUnstartedRun(
      deps,
      runId,
      watch,
      WORKSPACE_RECLAIMED_CODE,
      WORKSPACE_RECLAIMED_MESSAGE,
    );
    return;
  }
  teardown.handle = provisioned.handle;
  teardown.workspaceId = provisioned.workspace.id;
  await deps.repos.jobRuns.setStatus(runId, 'RUNNING', { workspaceId: provisioned.workspace.id });

  const request = buildJobTurnRequest({
    runId,
    model: deps.config.OPENAI_MODEL,
    instructions: buildTurnInstructions({
      repoUrl: job.repoUrl,
      baseBranch: job.branch,
      workBranch: defaultWorkBranch(runId, JOB_WORK_BRANCH_PREFIX),
    }),
    job: { repoUrl: job.repoUrl, branch: job.branch, prompt: job.prompt },
  });
  const recorder = createToolCallRecorder(deps, {
    workspaceId: provisioned.workspace.id,
    jobRunId: runId,
  });
  const outcome = await executeRuntimeTurn(deps, {
    handle: provisioned.handle,
    request,
    sink: makeJobRunSink(deps, runId, recorder),
    watch,
  });
  if (!outcome.reportedByRuntime) {
    await closeOutRun(deps, runId, outcome);
  }
  if (outcome.terminal === 'transport-error') {
    throw new Error('the workspace runner is unreachable');
  }
}

/**
 * Prepares the run, executes it and tears its workspace down whatever happened.
 *
 * @param deps - The processor's collaborators.
 * @param job - The job definition.
 * @param runId - The run this delivery drives.
 * @param watch - The cancellation subscription, open since before preparation started.
 * @throws Error When the Docker daemon is unreachable, so BullMQ retries.
 */
async function prepareAndRunJob(
  deps: ProcessorDeps,
  job: ScheduledJob,
  runId: string,
  watch: CancellationWatch,
): Promise<void> {
  await deps.repos.jobRuns.setStatus(runId, 'PREPARING');
  const teardown: Teardown = { runId, handle: null, workspaceId: null, job };
  try {
    if (watch.requested()) {
      await cancelRun(deps, runId);
      return;
    }
    await runInFreshWorkspace(deps, job, teardown, watch);
  } finally {
    await teardownRun(deps, teardown);
  }
}

/**
 * Runs the delivery once its watch is open, from the job lookup through to teardown.
 *
 * The subscription opens as early as the run's identity allows, and no earlier: a manual run
 * already has an id when this delivery is read — the API created the row and answered the
 * request with it before the job was ever enqueued — so `earlyWatch` is that subscription,
 * already receiving. A scheduled tick carries no id, and pub/sub cannot be asked to listen for a
 * key that does not exist yet, so its watch cannot open before {@link openRun} mints one; opening
 * it the moment that call returns is the earliest a subscriber could possibly matter, because
 * nothing could have named this run for cancellation any sooner than that.
 *
 * `earlyWatch`, when present, is only good for the run it was opened for. `openRun` mints a fresh
 * row, with a fresh id, whenever the run the delivery named cannot be adopted — and a watch left
 * on that stale id would never see a cancellation aimed at the row this function is about to run,
 * while reading as though the run were covered. `run.id` is compared against `payload.runId`
 * (the only id `earlyWatch` could have been opened for) and a fresh watch is opened on `run.id`
 * whenever they differ; `earlyWatch` itself is left for the caller to close, exactly as when it is
 * reused, so it is never closed twice.
 *
 * Opening the watch early is only half of honouring it. Every branch from here down that ends a run
 * without executing it — the job is gone, the job is disabled, the tick overlaps a run still
 * executing, the workspace could not be built — asks the watch first, through
 * {@link endUnstartedRun}, so a Stop the cancel route has already accepted decides the record
 * rather than being outrun by the reason the delivery was not going to proceed anyway.
 *
 * @param deps - The processor's collaborators.
 * @param payload - The parsed delivery.
 * @param delivery - The raw delivery, for its timestamp and stalled counter.
 * @param earlyWatch - The manual run's subscription, or `null` for a tick; owned by the caller.
 * @throws IneligibleRunError When the delivery names a run row it may not adopt.
 * @throws Error When the Docker daemon is unreachable, so BullMQ retries.
 */
async function runDelivery(
  deps: ProcessorDeps,
  payload: ScheduledDelivery,
  delivery: ProcessorJob<ScheduledDelivery>,
  earlyWatch: CancellationWatch | null,
): Promise<void> {
  const job = await deps.repos.scheduledJobs.get(payload.jobId);
  if (job === null) {
    deps.logger.warn({ jobId: payload.jobId }, 'scheduled job is gone');
    await closeUnrunnableRun(deps, payload, earlyWatch, JOB_MISSING_CODE, JOB_MISSING_MESSAGE);
    return;
  }
  if (!job.enabled) {
    deps.logger.info({ jobId: job.id }, 'scheduled job is disabled');
    await closeUnrunnableRun(deps, payload, earlyWatch, JOB_DISABLED_CODE, JOB_DISABLED_MESSAGE);
    return;
  }
  const scheduledFor =
    delivery.timestamp === undefined ? deps.clock.now() : new Date(delivery.timestamp);

  const running = await resolveRunningRun(deps, job.id, delivery.stalledCounter ?? 0);
  // The run this delivery drives is either brand new or an adopted `QUEUED` row, and neither is
  // what `findRunningByJob` answers with, so the two can never be the same record.
  const run = await openRun(deps, job, payload, scheduledFor);
  const canReuseEarlyWatch = earlyWatch !== null && run.id === payload.runId;
  const watch = canReuseEarlyWatch ? earlyWatch : await openCancellationWatch(deps, run.id);
  try {
    const overlap = decideOverlap({ runningRun: running });
    if (overlap.action === 'skip') {
      await recordSkippedTick(deps, job, run, overlap.reason, watch);
      return;
    }
    await prepareAndRunJob(deps, job, run.id, watch);
  } finally {
    if (!canReuseEarlyWatch) {
      await watch.close();
    }
  }
}

/**
 * Builds the `run-scheduled-job` consumer.
 *
 * A manual run's watch opens here, before the job row is even read: `payload.runId` arriving on
 * the delivery is what makes that possible, and every read this consumer does after parsing the
 * payload is time in which a Stop already has somewhere to land. {@link runDelivery} opens a
 * tick's watch itself, once its run row exists.
 *
 * @param deps - The processor's collaborators.
 * @returns A BullMQ processor for the `scheduled-jobs` queue.
 */
export function createRunScheduledJobProcessor(
  deps: ProcessorDeps,
): (job: ProcessorJob<ScheduledDelivery>) => Promise<void> {
  return async (delivery: ProcessorJob<ScheduledDelivery>): Promise<void> => {
    const payload = scheduledDeliveryPayload.parse(delivery.data);
    const earlyWatch =
      payload.runId === undefined ? null : await openCancellationWatch(deps, payload.runId);
    try {
      await runDelivery(deps, payload, delivery, earlyWatch);
    } finally {
      await earlyWatch?.close();
    }
  };
}
