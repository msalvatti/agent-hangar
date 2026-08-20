/**
 * The `run-scheduled-job` consumer: one cron tick, one fresh workspace, one recorded run.
 *
 * Layer: service (processor).
 *
 * Two guarantees shape the whole file. Every run gets its own container and that container is
 * destroyed in a `finally`, whatever happened — a job that leaked one workspace per tick would eat
 * the machine within a day. And a tick that fires while the previous run is still executing is
 * recorded as a failed run rather than queued, because queueing would let a slow job accumulate
 * exactly those containers.
 */
import {
  buildJobTurnRequest,
  decideOverlap,
  defaultWorkBranch,
  InvalidCronError,
  isTerminalRunStatus,
  JOB_WORK_BRANCH_PREFIX,
  nextRunAt,
  runScheduledJobPayload,
} from '@agent-hangar/core';
import type { AgentEvent, JobRun, ScheduledJob, WorkspaceHandle } from '@agent-hangar/core';
import { z } from 'zod';

import { NO_USAGE, WORKER_ERROR_PREFIX } from './constants.js';
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
    await publishCancellation(deps, runId);
    await deps.repos.jobRuns.finish(runId, { status: 'CANCELLED', usage: NO_USAGE });
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
 * It goes through the same failure path as every other failed run, terminal event included. A
 * manual run already has a browser attached to its stream, and a run finished without a terminal
 * event leaves that page waiting for something nobody is going to send.
 *
 * The run times are deliberately left alone: the run that is still executing owns them, and
 * moving `nextRunAt` here would report a schedule the job is not following.
 *
 * @param deps - Publisher, repositories and logger.
 * @param job - The job definition.
 * @param run - The run being dropped.
 * @param reason - Why it was dropped.
 */
async function recordSkippedTick(
  deps: ProcessorDeps,
  job: ScheduledJob,
  run: JobRun,
  reason: string,
): Promise<void> {
  await failRun(deps, run.id, OVERLAP_SKIP_CODE, reason);
  deps.logger.info({ jobId: job.id, runId: run.id }, 'scheduled run skipped');
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
 * @param job - The job the delivery belongs to.
 * @returns `true` when the row is this delivery's to drive.
 */
function mayAdopt(run: JobRun, job: ScheduledJob): boolean {
  return run.jobId === job.id && run.trigger === 'MANUAL' && run.status === 'QUEUED';
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
      if (!mayAdopt(adopted, job)) {
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
 * @param runId - The run.
 * @param teardown - Filled in as the workspace appears, so the `finally` can tear it down.
 * @throws Error When the Docker daemon is unreachable, so BullMQ retries.
 */
async function runInFreshWorkspace(
  deps: ProcessorDeps,
  job: ScheduledJob,
  runId: string,
  teardown: Teardown,
): Promise<void> {
  const provisioned = await provisionWorkspace(deps, {
    kind: 'JOB',
    jobRunId: runId,
    repoUrl: job.repoUrl,
    branch: job.branch,
  });
  if (!provisioned.ok) {
    await failRun(deps, runId, provisioned.reason, provisioned.message);
    return;
  }
  teardown.handle = provisioned.handle;
  teardown.workspaceId = provisioned.workspace.id;
  await deps.repos.jobRuns.setStatus(runId, 'RUNNING', { workspaceId: provisioned.workspace.id });
  await deps.repos.workspaces.setStatus(provisioned.workspace.id, 'BUSY');

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
    cancelKey: runId,
  });
  if (!outcome.reportedByRuntime) {
    await closeOutRun(deps, runId, outcome);
  }
  if (outcome.terminal === 'transport-error') {
    throw new Error('the workspace runner is unreachable');
  }
}

/**
 * Builds the `run-scheduled-job` consumer.
 *
 * @param deps - The processor's collaborators.
 * @returns A BullMQ processor for the `scheduled-jobs` queue.
 */
export function createRunScheduledJobProcessor(
  deps: ProcessorDeps,
): (job: ProcessorJob<ScheduledDelivery>) => Promise<void> {
  return async (delivery: ProcessorJob<ScheduledDelivery>): Promise<void> => {
    const payload = scheduledDeliveryPayload.parse(delivery.data);
    const job = await deps.repos.scheduledJobs.get(payload.jobId);
    if (job === null) {
      deps.logger.warn({ jobId: payload.jobId }, 'scheduled job is gone');
      return;
    }
    if (!job.enabled) {
      deps.logger.info({ jobId: job.id }, 'scheduled job is disabled');
      return;
    }
    const scheduledFor =
      delivery.timestamp === undefined ? deps.clock.now() : new Date(delivery.timestamp);

    const running = await deps.repos.jobRuns.findRunningByJob(job.id);
    // The run this delivery drives is either brand new or an adopted `QUEUED` row, and neither is
    // what `findRunningByJob` answers with, so the two can never be the same record.
    const run = await openRun(deps, job, payload, scheduledFor);
    const overlap = decideOverlap({ runningRun: running });
    if (overlap.action === 'skip') {
      await recordSkippedTick(deps, job, run, overlap.reason);
      return;
    }
    await deps.repos.jobRuns.setStatus(run.id, 'PREPARING');
    const teardown: Teardown = { runId: run.id, handle: null, workspaceId: null, job };
    try {
      await runInFreshWorkspace(deps, job, run.id, teardown);
    } finally {
      await teardownRun(deps, teardown);
    }
  };
}
