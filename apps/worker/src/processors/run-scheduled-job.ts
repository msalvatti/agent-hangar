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
 * The second guarantee is about a live predecessor, not a dead one, and the difference decides
 * whether a crash is survivable. A worker that dies mid-run leaves its `JobRun` in `RUNNING` and
 * its workspace in `BUSY`, and nothing else in the system reclaims either — the collector
 * reconciles only `READY` and `STOPPING` rows, the idle selector takes only `READY`, and orphan
 * reconciliation correctly leaves a container alone while a live row points at it. Treating that
 * abandoned row as an overlap would make every later tick of the job skip for ever and leak one
 * container per crash, so a redelivery closes its predecessor out first and then runs the tick.
 *
 * Which row a delivery is entitled to drive — the adoption rules, the overlap decision and the
 * recovery of an abandoned predecessor — is the subject of `./run-scheduled-job-deliveries.ts`,
 * which the second guarantee above is stated by. This file is the run itself: provision, take,
 * execute, tear down.
 */
import {
  buildJobTurnRequest,
  decideOverlap,
  defaultWorkBranch,
  isTerminalRunStatus,
  JOB_WORK_BRANCH_PREFIX,
  runScheduledJobPayload,
} from '@agent-hangar/core';
import type {
  AgentEvent,
  RunScheduledJobPayload,
  ScheduledJob,
  Workspace,
  WorkspaceHandle,
} from '@agent-hangar/core';

import { openCancellationWatch } from './cancellation.js';
import type { CancellationWatch } from './cancellation.js';
import {
  JOB_DISABLED_CODE,
  JOB_DISABLED_MESSAGE,
  JOB_MISSING_CODE,
  JOB_MISSING_MESSAGE,
  NO_USAGE,
  WORKER_ERROR_PREFIX,
  WORKSPACE_RECLAIMED_CODE,
  WORKSPACE_RECLAIMED_MESSAGE,
} from './constants.js';
import { buildTurnInstructions } from './instructions.js';
import { provisionWorkspace, takeReadyWorkspace } from './provision-workspace.js';
import { cancelRun, endUnstartedRun, failRun, formatRunError } from './run-outcome.js';
import {
  closeUnrunnableRun,
  openRun,
  recordSkippedTick,
  resolveRunningRun,
} from './run-scheduled-job-deliveries.js';
import { updateRunTimes } from './run-times.js';
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
 * A run has no chat, so nothing becomes a message: the final answer is the run's `output`, the tool
 * calls are its log, and where it pushed is on the run's own row. That last one is a column rather
 * than a notice because a run has no message channel to put a notice in, and giving it one would
 * mean a history nothing reads — a run always starts in a fresh workspace from the job's prompt, so
 * there is no window to feed. What a column is for is the opposite: a fact that has to outlive the
 * container, and the branch a scheduled coding job pushed to is the only one a run produces.
 *
 * Everything else the runtime reports is published for the live view and kept nowhere. A
 * preparation finding describes the checkout the run started from, which its container took with
 * it, and the assistant's stream is already summarised by `output`.
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
        case 'git.pushed':
          await deps.repos.jobRuns.recordPush(runId, {
            workBranch: event.branch,
            lastPushedSha: event.sha,
          });
          break;
        case 'turn.started':
        case 'prepare.progress':
        case 'prepare.done':
        case 'assistant.delta':
        case 'assistant.message':
        case 'heartbeat':
        case 'protocol.error':
          // Published for the live view and kept nowhere: nothing they carry outlives the
          // container, and `output` already carries the answer the assistant streamed.
          break;
      }
    },
  };
}

/**
 * Destroys the run's workspace and leaves nothing half-written, whatever happened above.
 *
 * The status write is unconditional because there is nobody to lose a race to: `teardown` names a
 * workspace only once this run took it `BUSY`, and every other writer takes `READY` or `STOPPING`.
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
 * Takes the workspace this run provisioned, or ends the run because something else took it first.
 *
 * The run records the workspace *before* taking it, which is what leaves the stalled-run recovery a
 * handle if a process dies between the two writes: the run's `workspaceId` is the only link, because
 * the row carries no reference back. {@link destroyAbandonedWorkspace} is what stops a run that
 * recorded but never took one destroying it; {@link takeReadyWorkspace}, why the take is
 * conditional.
 *
 * @param deps - The processor's collaborators.
 * @param teardown - Filled in once the workspace is this run's, so the `finally` tears it down.
 * @param workspace - The row provisioning produced.
 * @param handle - The container reference provisioning produced.
 * @param watch - The run's cancellation subscription, consulted before the loss is recorded.
 * @returns `true` when the run owns the workspace, `false` when the run has been ended here.
 */
async function takeWorkspaceForRun(
  deps: ProcessorDeps,
  teardown: Teardown,
  workspace: Workspace,
  handle: WorkspaceHandle,
  watch: CancellationWatch,
): Promise<boolean> {
  const { runId } = teardown;
  await deps.repos.jobRuns.setStatus(runId, 'PREPARING', { workspaceId: workspace.id });
  if ((await takeReadyWorkspace(deps, workspace.id)) === null) {
    deps.logger.warn(
      { runId, workspaceId: workspace.id },
      'the workspace this run provisioned was reclaimed before it could be used',
    );
    await endUnstartedRun(
      deps,
      runId,
      watch,
      WORKSPACE_RECLAIMED_CODE,
      WORKSPACE_RECLAIMED_MESSAGE,
    );
    return false;
  }
  teardown.handle = handle;
  teardown.workspaceId = workspace.id;
  await deps.repos.jobRuns.setStatus(runId, 'RUNNING');
  return true;
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
 * @throws Error When the Docker daemon is unreachable, which is reported as a failed job; the run
 *   is recorded by the teardown in the `finally` before it is thrown.
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
  if (
    !(await takeWorkspaceForRun(deps, teardown, provisioned.workspace, provisioned.handle, watch))
  ) {
    return;
  }

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
 * @throws Error When the Docker daemon is unreachable, which is reported as a failed job; the run
 *   is recorded by the teardown in the `finally` before it is thrown.
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
 * @throws Error When the Docker daemon is unreachable, which is reported as a failed job; the run
 *   is recorded by the teardown in the `finally` before it is thrown.
 */
async function runDelivery(
  deps: ProcessorDeps,
  payload: RunScheduledJobPayload,
  delivery: ProcessorJob<RunScheduledJobPayload>,
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
): (job: ProcessorJob<RunScheduledJobPayload>) => Promise<void> {
  return async (delivery: ProcessorJob<RunScheduledJobPayload>): Promise<void> => {
    const payload = runScheduledJobPayload.parse(delivery.data);
    const earlyWatch =
      payload.runId === undefined ? null : await openCancellationWatch(deps, payload.runId);
    try {
      await runDelivery(deps, payload, delivery, earlyWatch);
    } finally {
      await earlyWatch?.close();
    }
  };
}
