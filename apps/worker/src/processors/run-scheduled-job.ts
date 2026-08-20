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
  InvalidCronError,
  isTerminalRunStatus,
  nextRunAt,
  runScheduledJobPayload,
} from '@agent-hangar/core';
import type {
  AgentEvent,
  RunScheduledJobPayload,
  ScheduledJob,
  WorkspaceHandle,
} from '@agent-hangar/core';

import { NO_USAGE, WORKER_ERROR_PREFIX } from './constants.js';
import { buildTurnInstructions } from './instructions.js';
import { provisionWorkspace } from './provision-workspace.js';
import { formatRunError, publishCancellation, publishFailure } from './run-outcome.js';
import { createToolCallRecorder } from './tool-call-recorder.js';
import type { ToolCallRecorder } from './tool-call-recorder.js';
import { executeRuntimeTurn } from './turn-executor.js';
import type { TurnSink, UnreportedOutcome } from './turn-executor.js';
import type { ProcessorDeps, ProcessorJob } from './types.js';

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
          await deps.repos.jobRuns.finish(runId, {
            status: 'SUCCEEDED',
            output: event.finalMessage,
            usage: {
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              stepCount: event.steps,
            },
          });
          break;
        case 'turn.failed':
          await deps.repos.jobRuns.finish(runId, {
            status: 'FAILED',
            usage: { ...NO_USAGE, stepCount: steps },
            error: formatRunError(event.error.code, event.error.message),
          });
          break;
        case 'turn.cancelled':
          await deps.repos.jobRuns.finish(runId, {
            status: 'CANCELLED',
            usage: { ...NO_USAGE, stepCount: steps },
          });
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
 * The run times are deliberately left alone: the run that is still executing owns them, and
 * moving `nextRunAt` here would report a schedule the job is not following.
 *
 * @param deps - Repositories and logger.
 * @param job - The job definition.
 * @param payload - The delivery being dropped.
 * @param scheduledFor - The tick this delivery belongs to.
 * @param reason - Why it was dropped.
 */
async function recordSkippedTick(
  deps: ProcessorDeps,
  job: ScheduledJob,
  payload: RunScheduledJobPayload,
  scheduledFor: Date,
  reason: string,
): Promise<void> {
  const run = await deps.repos.jobRuns.create({
    jobId: job.id,
    trigger: payload.trigger,
    model: deps.config.OPENAI_MODEL,
    scheduledFor,
  });
  await deps.repos.jobRuns.finish(run.id, { status: 'FAILED', usage: NO_USAGE, error: reason });
  deps.logger.info({ jobId: job.id, runId: run.id }, 'scheduled run skipped');
}

/**
 * Runs the prepared run to completion inside its own workspace.
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
      workBranch: job.branch,
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
): (job: ProcessorJob<RunScheduledJobPayload>) => Promise<void> {
  return async (delivery: ProcessorJob<RunScheduledJobPayload>): Promise<void> => {
    const payload = runScheduledJobPayload.parse(delivery.data);
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
    const overlap = decideOverlap({ runningRun: running });
    if (overlap.action === 'skip') {
      await recordSkippedTick(deps, job, payload, scheduledFor, overlap.reason);
      return;
    }

    const run = await deps.repos.jobRuns.create({
      jobId: job.id,
      trigger: payload.trigger,
      model: deps.config.OPENAI_MODEL,
      scheduledFor,
    });
    await deps.repos.jobRuns.setStatus(run.id, 'PREPARING');
    const teardown: Teardown = { runId: run.id, handle: null, workspaceId: null, job };
    try {
      await runInFreshWorkspace(deps, job, run.id, teardown);
    } finally {
      await teardownRun(deps, teardown);
    }
  };
}
