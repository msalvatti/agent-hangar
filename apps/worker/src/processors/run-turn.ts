/**
 * The `run-turn` consumer: one user message answered inside a workspace.
 *
 * Layer: service (processor).
 *
 * Restore is not a separate path. The processor always asks "does this chat have a live
 * workspace?", and when it does not it creates one and clones from the persisted history — which
 * is why an archived chat, a workspace the collector reaped and a worker that died mid-turn all
 * behave identically, and why the restore path is exercised by every long-lived chat rather than
 * only by an archived one.
 *
 * Failure policy: only an unreachable Docker daemon rejects, so BullMQ retries it. Everything else
 * — a missing credential, a missing image, a runtime that exited non-zero — is a failed turn, and
 * a failed turn is a result: retrying it would collect one identical failure per attempt while the
 * user watches.
 */
import {
  buildRestoreContext,
  buildTurnRequest,
  ensureWorkspaceDecision,
  isTerminalRunStatus,
  LiveWorkspaceExistsError,
  runTurnPayload,
} from '@agent-hangar/core';
import type {
  AgentEvent,
  Chat,
  EnsureWorkspaceDecision,
  Message,
  RunTurnPayload,
  Workspace,
  WorkspaceHandle,
} from '@agent-hangar/core';

import {
  NO_USAGE,
  STALLED_RECOVERY_NOTE,
  STALLED_RECOVERY_REASON,
  WORKER_ERROR_PREFIX,
} from './constants.js';
import { buildTurnInstructions } from './instructions.js';
import { provisionWorkspace } from './provision-workspace.js';
import { formatRunError, publishCancellation, publishFailure } from './run-outcome.js';
import { createToolCallRecorder } from './tool-call-recorder.js';
import type { ToolCallRecorder } from './tool-call-recorder.js';
import { executeRuntimeTurn } from './turn-executor.js';
import type { ExecOutcome, TurnSink, UnreportedOutcome } from './turn-executor.js';
import type { ProcessorDeps, ProcessorJob } from './types.js';

/** Failure code recorded when another turn of the same chat owns the one live workspace. */
export const WORKSPACE_CONFLICT_CODE = 'workspace_conflict';

/** What the user is told when that happens. */
export const WORKSPACE_CONFLICT_MESSAGE =
  'Another turn of this chat is already using its workspace; send the message again once it finishes.';

/** Everything one turn carries from preparation into execution. */
interface TurnContext {
  turnId: string;
  chat: Chat;
  workspace: Workspace;
  handle: WorkspaceHandle;
  decision: EnsureWorkspaceDecision;
  messages: Message[];
}

/** Either a workspace ready to run in, or why the turn cannot start. */
type EnsureResult =
  | { ok: true; workspace: Workspace; handle: WorkspaceHandle; decision: EnsureWorkspaceDecision }
  | { ok: false; code: string; message: string };

/**
 * Builds the runner handle of a persisted workspace.
 *
 * @param workspace - The row.
 * @returns Its handle; an empty reference for a row whose container never reported one, which the
 *   runner reports as `gone` rather than mistaking for another container.
 */
function handleOf(workspace: Workspace): WorkspaceHandle {
  return { workspaceId: workspace.id, runnerRef: workspace.runnerRef ?? '' };
}

/**
 * Records a turn as failed and tells the UI why.
 *
 * @param deps - Publisher and repositories.
 * @param turnId - The turn.
 * @param code - Machine-readable failure code.
 * @param message - Human-readable detail; already safe to persist.
 */
async function failTurn(
  deps: ProcessorDeps,
  turnId: string,
  code: string,
  message: string,
): Promise<void> {
  await publishFailure(deps, turnId, code, message);
  await deps.repos.turns.finish(turnId, 'FAILED', NO_USAGE, formatRunError(code, message));
}

/**
 * Destroys a workspace whose previous owner never released it.
 *
 * A workspace found in a transient state, or any live workspace on a retried job, belonged to an
 * attempt that is no longer running: its container may still be alive but nothing is reading its
 * exec any more. The model is told, because the filesystem it remembers writing to is gone.
 *
 * @param deps - Runner, repositories and logger.
 * @param chat - The chat whose workspace is inspected.
 * @param attemptsMade - How many times BullMQ already delivered this job.
 */
async function recoverStalledWorkspace(
  deps: ProcessorDeps,
  chat: Chat,
  attemptsMade: number,
): Promise<void> {
  const live = await deps.repos.workspaces.findLiveByChat(chat.id);
  if (live === null || (live.status === 'READY' && attemptsMade === 0)) {
    return;
  }
  try {
    await deps.runner.destroy(handleOf(live));
  } catch (error) {
    deps.logger.warn({ err: error, workspaceId: live.id }, 'destroying a stalled workspace failed');
  }
  await deps.repos.workspaces.setStatus(live.id, 'DESTROYED', {
    failureReason: STALLED_RECOVERY_REASON,
  });
  await deps.repos.messages.append(chat.id, 'SYSTEM', STALLED_RECOVERY_NOTE);
}

/**
 * Closes out a live workspace row whose container no longer answers.
 *
 * @param deps - Runner and repositories.
 * @param chatId - The chat to inspect.
 * @returns The workspace that may be reused, or `null`.
 */
async function reviewLiveWorkspace(deps: ProcessorDeps, chatId: string): Promise<Workspace | null> {
  const live = await deps.repos.workspaces.findLiveByChat(chatId);
  if (live === null) {
    return null;
  }
  const health = await deps.runner.health(handleOf(live));
  if (health.status === 'gone') {
    await deps.repos.workspaces.setStatus(live.id, 'DESTROYED');
    return null;
  }
  if (health.status === 'unhealthy') {
    await deps.repos.workspaces.setStatus(live.id, 'FAILED', { failureReason: health.reason });
    return null;
  }
  return live;
}

/**
 * Creates the chat's workspace, resolving the race with a concurrent turn of the same chat.
 *
 * @param deps - The processor's collaborators.
 * @param chat - The chat the workspace serves.
 * @param decision - The ensure decision this create belongs to.
 * @returns The ready workspace, or why it could not be created.
 */
async function createForChat(
  deps: ProcessorDeps,
  chat: Chat,
  decision: EnsureWorkspaceDecision,
): Promise<EnsureResult> {
  try {
    const provisioned = await provisionWorkspace(deps, {
      kind: 'CHAT',
      chatId: chat.id,
      repoUrl: chat.repoUrl,
      branch: chat.workBranch ?? chat.baseBranch,
    });
    if (!provisioned.ok) {
      return { ok: false, code: provisioned.reason, message: provisioned.message };
    }
    return { ok: true, workspace: provisioned.workspace, handle: provisioned.handle, decision };
  } catch (error) {
    if (!(error instanceof LiveWorkspaceExistsError)) {
      throw error;
    }
    const live = await deps.repos.workspaces.findLiveByChat(chat.id);
    if (live === null) {
      return { ok: false, code: WORKSPACE_CONFLICT_CODE, message: WORKSPACE_CONFLICT_MESSAGE };
    }
    // The other turn created the row and is about to run in it. Reusing the container it just
    // built is what a second message to the same chat does anyway; the chat's turns are answered
    // one at a time because they share this one workspace.
    return { ok: true, workspace: live, handle: handleOf(live), decision };
  }
}

/**
 * Finds or creates the workspace this turn runs in.
 *
 * @param deps - The processor's collaborators.
 * @param chat - The chat.
 * @param messages - Its stored history, used to rebuild a workspace that is gone.
 * @param attemptsMade - How many times BullMQ already delivered this job.
 * @returns The workspace and the decision that produced it, or why the turn cannot start.
 * @throws WorkspaceBusyError When a concurrent attempt is holding the workspace; BullMQ surfaces
 *   it as a failed job rather than the worker guessing what the other attempt is doing.
 */
async function ensureWorkspace(
  deps: ProcessorDeps,
  chat: Chat,
  messages: readonly Message[],
  attemptsMade: number,
): Promise<EnsureResult> {
  await recoverStalledWorkspace(deps, chat, attemptsMade);
  const live = await reviewLiveWorkspace(deps, chat.id);
  const decision = ensureWorkspaceDecision({
    liveWorkspace: live === null ? null : { id: live.id, status: live.status },
    image: deps.config.WORKSPACE_IMAGE,
    // The runner is the authority on image presence: `create` raises `WorkspaceImageMissing` with
    // the build command, and the port offers no cheaper probe. Claiming presence here defers the
    // check to that call; it never skips it.
    imagePresent: true,
    restore: buildRestoreContext({ chat, messages, now: deps.clock.now() }),
  });
  if (live !== null) {
    return { ok: true, workspace: live, handle: handleOf(live), decision };
  }
  return createForChat(deps, chat, decision);
}

/**
 * Builds the persistence half of the event stream.
 *
 * Every event it receives has already been redacted and published, so this function is purely
 * about which rows an event produces.
 *
 * @param deps - Repositories.
 * @param context - The turn being run.
 * @param recorder - Tool-call bookkeeping, whose summaries the completion writes as messages.
 * @returns The sink.
 */
function makeTurnSink(
  deps: ProcessorDeps,
  context: TurnContext,
  recorder: ToolCallRecorder,
): TurnSink {
  let steps = 0;
  return {
    async onEvent(event: AgentEvent): Promise<void> {
      switch (event.type) {
        case 'turn.started':
          await deps.repos.turns.setStatus(context.turnId, 'RUNNING');
          break;
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
        case 'git.pushed':
          await deps.repos.chats.updateRestoreHints(context.chat.id, {
            workBranch: event.branch,
            lastPushedSha: event.sha,
          });
          break;
        case 'turn.completed':
          await completeTurn(deps, context, recorder, event);
          break;
        case 'turn.failed':
          await deps.repos.turns.finish(
            context.turnId,
            'FAILED',
            { ...NO_USAGE, stepCount: steps },
            formatRunError(event.error.code, event.error.message),
          );
          break;
        case 'turn.cancelled':
          await deps.repos.turns.finish(context.turnId, 'CANCELLED', {
            ...NO_USAGE,
            stepCount: steps,
          });
          break;
        case 'prepare.progress':
        case 'prepare.done':
        case 'assistant.delta':
        case 'assistant.message':
        case 'heartbeat':
        case 'protocol.error':
          // Published and shown, but nothing about them belongs in a row: the transcript is
          // rebuilt from the messages and the tool-call log, not from the live stream.
          break;
      }
    },
  };
}

/**
 * Writes what a completed turn leaves behind: one summary per tool call, the answer, the totals.
 *
 * The summaries are written before the answer so the transcript reads in the order things
 * happened, and so a later turn's history window carries the actions ahead of the conclusion.
 *
 * @param deps - Repositories.
 * @param context - The turn being run.
 * @param recorder - Source of the tool summaries.
 * @param event - The completion event, already redacted.
 */
async function completeTurn(
  deps: ProcessorDeps,
  context: TurnContext,
  recorder: ToolCallRecorder,
  event: Extract<AgentEvent, { type: 'turn.completed' }>,
): Promise<void> {
  for (const summary of recorder.summaries()) {
    await deps.repos.messages.append(context.chat.id, 'TOOL_SUMMARY', summary, context.turnId);
  }
  await deps.repos.messages.append(
    context.chat.id,
    'ASSISTANT',
    event.finalMessage,
    context.turnId,
  );
  await deps.repos.turns.finish(context.turnId, 'SUCCEEDED', {
    inputTokens: event.usage.inputTokens,
    outputTokens: event.usage.outputTokens,
    stepCount: event.steps,
  });
}

/**
 * Writes the outcome for a turn whose runtime never reported one.
 *
 * A cancellation that the runtime did not acknowledge is still a cancellation: the user asked for
 * it and the exec is over. Everything else is a failure.
 *
 * @param deps - Publisher and repositories.
 * @param turnId - The turn.
 * @param outcome - What the executor observed.
 */
async function closeOutTurn(
  deps: ProcessorDeps,
  turnId: string,
  outcome: UnreportedOutcome,
): Promise<void> {
  if (outcome.terminal === 'cancelled') {
    await publishCancellation(deps, turnId);
    await deps.repos.turns.finish(turnId, 'CANCELLED', NO_USAGE);
    return;
  }
  await failTurn(deps, turnId, outcome.error.code, outcome.error.message);
}

/**
 * Records the outcome the runtime did not describe itself, and releases the workspace.
 *
 * @param deps - Repositories and publisher.
 * @param context - The turn being run.
 * @param outcome - What the executor observed.
 * @throws Error When the failure was the Docker daemon being unreachable, so BullMQ retries.
 */
async function finalizeTurn(
  deps: ProcessorDeps,
  context: TurnContext,
  outcome: ExecOutcome,
): Promise<void> {
  if (!outcome.reportedByRuntime) {
    await closeOutTurn(deps, context.turnId, outcome);
  }
  if (outcome.terminal === 'transport-error') {
    await deps.repos.workspaces.setStatus(context.workspace.id, 'FAILED', {
      failureReason: 'docker unreachable',
    });
    return;
  }
  await deps.repos.workspaces.setStatus(context.workspace.id, 'READY');
  await deps.repos.workspaces.markActive(context.workspace.id);
  await deps.repos.chats.touch(context.chat.id);
}

/**
 * Leaves nothing half-written, whatever happened above.
 *
 * @param deps - Repositories.
 * @param turnId - The turn.
 * @param workspaceId - The workspace it ran in.
 */
async function settleTurn(deps: ProcessorDeps, turnId: string, workspaceId: string): Promise<void> {
  const turn = await deps.repos.turns.get(turnId);
  if (turn !== null && !isTerminalRunStatus(turn.status)) {
    await deps.repos.turns.finish(
      turnId,
      'FAILED',
      NO_USAGE,
      `${WORKER_ERROR_PREFIX}: the worker stopped before the turn finished`,
    );
  }
  const workspace = await deps.repos.workspaces.get(workspaceId);
  if (workspace !== null && workspace.status === 'BUSY') {
    await deps.repos.workspaces.setStatus(workspaceId, 'READY');
  }
}

/**
 * Runs the prepared turn to completion.
 *
 * @param deps - The processor's collaborators.
 * @param context - The turn being run.
 * @throws Error When the Docker daemon is unreachable.
 */
async function runPreparedTurn(deps: ProcessorDeps, context: TurnContext): Promise<void> {
  await deps.repos.workspaces.setStatus(context.workspace.id, 'BUSY');
  const request = buildTurnRequest({
    turnId: context.turnId,
    model: deps.config.OPENAI_MODEL,
    instructions: buildTurnInstructions({
      repoUrl: context.chat.repoUrl,
      baseBranch: context.chat.baseBranch,
      workBranch: context.chat.workBranch ?? context.chat.baseBranch,
    }),
    chat: context.chat,
    messages: context.messages,
    decision: context.decision,
  });
  const recorder = createToolCallRecorder(deps, {
    workspaceId: context.workspace.id,
    turnId: context.turnId,
  });
  const outcome = await executeRuntimeTurn(deps, {
    handle: context.handle,
    request,
    sink: makeTurnSink(deps, context, recorder),
    cancelKey: context.turnId,
  });
  await finalizeTurn(deps, context, outcome);
  if (outcome.terminal === 'transport-error') {
    throw new Error('the workspace runner is unreachable');
  }
}

/**
 * Builds the `run-turn` consumer.
 *
 * @param deps - The processor's collaborators.
 * @returns A BullMQ processor for the `chat-turns` queue.
 */
export function createRunTurnProcessor(
  deps: ProcessorDeps,
): (job: ProcessorJob<RunTurnPayload>) => Promise<void> {
  return async (job: ProcessorJob<RunTurnPayload>): Promise<void> => {
    const { turnId } = runTurnPayload.parse(job.data);
    const turn = await deps.repos.turns.get(turnId);
    if (turn === null || isTerminalRunStatus(turn.status)) {
      deps.logger.warn({ turnId }, 'run-turn skipped: the turn is gone or already finished');
      return;
    }
    const chat = await deps.repos.chats.getById(turn.chatId);
    if (chat === null) {
      await failTurn(
        deps,
        turnId,
        'chat_not_found',
        'the chat this turn belongs to no longer exists',
      );
      return;
    }
    await deps.repos.turns.setStatus(turnId, 'PREPARING');

    const messages = await deps.repos.messages.listByChat(chat.id);
    const ensured = await ensureWorkspace(deps, chat, messages, job.attemptsMade);
    if (!ensured.ok) {
      await failTurn(deps, turnId, ensured.code, ensured.message);
      return;
    }
    await deps.repos.turns.setStatus(turnId, 'PREPARING', { workspaceId: ensured.workspace.id });

    const context: TurnContext = {
      turnId,
      chat,
      workspace: ensured.workspace,
      handle: ensured.handle,
      decision: ensured.decision,
      messages,
    };
    try {
      await runPreparedTurn(deps, context);
    } finally {
      await settleTurn(deps, turnId, context.workspace.id);
    }
  };
}
