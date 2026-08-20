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
  defaultWorkBranch,
  ensureWorkspaceDecision,
  isTerminalRunStatus,
  LiveWorkspaceExistsError,
  pushedNoticeText,
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

import { chatClaimKey, turnClaimKey } from '../claims.js';

import { openCancellationWatch } from './cancellation.js';
import type { CancellationWatch } from './cancellation.js';
import {
  NO_USAGE,
  STALLED_RECOVERY_NOTE,
  STALLED_RECOVERY_REASON,
  WORKER_ERROR_PREFIX,
} from './constants.js';
import { buildTurnInstructions } from './instructions.js';
import {
  isRepoUrlAllowed,
  provisionWorkspace,
  REPO_URL_NOT_ALLOWED_CODE,
  REPO_URL_NOT_ALLOWED_MESSAGE,
} from './provision-workspace.js';
import { formatRunError, publishCancellation, publishFailure } from './run-outcome.js';
import { createToolCallRecorder } from './tool-call-recorder.js';
import type { ToolCallRecorder } from './tool-call-recorder.js';
import { executeRuntimeTurn } from './turn-executor.js';
import type { ExecOutcome, TurnSink, UnreportedOutcome } from './turn-executor.js';
import type { ProcessorDeps, ProcessorJob } from './types.js';

/** Failure code recorded when something else owns the one live workspace of this chat. */
export const WORKSPACE_CONFLICT_CODE = 'workspace_conflict';

/** What the user is told when that happens. */
export const WORKSPACE_CONFLICT_MESSAGE =
  'The workspace of this chat is busy with another operation; send the message again in a moment.';

/** What one delivery of the job carries into preparation. */
interface TurnDelivery {
  turnId: string;
  chat: Chat;
  /** How many times BullMQ already delivered this job. */
  attemptsMade: number;
}

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
 * Creates the chat's workspace, or reports that somebody else got there first.
 *
 * The database allows a chat one live workspace, and that partial unique index is the claim: the
 * create that raises `LiveWorkspaceExistsError` is the one that lost. Adopting the winner's row
 * would put two turns in one filesystem, each believing it owns it, so the loser reports a
 * conflict and the user sends the message again once the other turn has finished.
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
    deps.logger.warn(
      { chatId: chat.id },
      'another writer created the workspace of this chat first',
    );
    return { ok: false, code: WORKSPACE_CONFLICT_CODE, message: WORKSPACE_CONFLICT_MESSAGE };
  }
}

/**
 * Finds or creates the workspace this turn runs in.
 *
 * @param deps - The processor's collaborators.
 * @param chat - The chat.
 * @param messages - Its stored history, used to rebuild a workspace that is gone.
 * @returns The workspace and the decision that produced it, or why the turn cannot start.
 */
async function ensureWorkspace(
  deps: ProcessorDeps,
  chat: Chat,
  messages: readonly Message[],
): Promise<EnsureResult> {
  // Measured here and not only where a workspace is created: a chat whose container is still
  // running reuses it, so an origin the operator has removed from the allow-list would keep
  // receiving pushes for as long as the idle collector leaves that container standing.
  if (!isRepoUrlAllowed(deps, chat.repoUrl)) {
    return {
      ok: false,
      code: REPO_URL_NOT_ALLOWED_CODE,
      message: REPO_URL_NOT_ALLOWED_MESSAGE,
    };
  }
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
 * Records a push: as the hints a later turn restores from, and as a line of the transcript.
 *
 * The hints carry only the newest push, and the transcript has to show every one of them where it
 * happened. A push is also the one thing a turn does that outlives its workspace — the commit it
 * names is in the remote repository long after the container is gone — so it earns a row.
 *
 * @param deps - Repositories.
 * @param context - The turn being run.
 * @param event - The push, already redacted.
 */
async function recordPush(
  deps: ProcessorDeps,
  context: TurnContext,
  event: Extract<AgentEvent, { type: 'git.pushed' }>,
): Promise<void> {
  await deps.repos.chats.updateRestoreHints(context.chat.id, {
    workBranch: event.branch,
    lastPushedSha: event.sha,
  });
  await deps.repos.messages.append(
    context.chat.id,
    'SYSTEM',
    pushedNoticeText(event.branch, event.sha),
    context.turnId,
  );
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
          await recordPush(deps, context, event);
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
          // Published and shown, but nothing about them belongs in a row. They all describe the
          // container while it is being set up or while the model is thinking, and the container
          // does not outlive the turn; what the turn actually did is in its tool calls and its
          // answer. Keeping them would also cost the model a line of history per turn, since a
          // stored SYSTEM message is part of the window a later turn carries.
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
 * Records a turn the user stopped before its exec began.
 *
 * The workspace is left as it is: nothing ran in it, so the next message reuses it.
 *
 * @param deps - Publisher and repositories.
 * @param turnId - The turn.
 */
async function cancelBeforeStart(deps: ProcessorDeps, turnId: string): Promise<void> {
  await publishCancellation(deps, turnId);
  await deps.repos.turns.finish(turnId, 'CANCELLED', NO_USAGE);
}

/**
 * Ends a turn that never started: as the cancellation the user asked for when one arrived, and
 * otherwise as the reason the turn could not begin.
 *
 * Both facts can hold of the same delivery. The user pressed Stop — and `POST /api/turns/:id/cancel`
 * answered `202`, which is a promise about this very row — while the turn was independently going
 * nowhere: its chat was deleted, another turn of the chat holds the workspace, or the workspace
 * could not be prepared. Only one record gets written, and it is `CANCELLED`.
 *
 * The case for `FAILED` is that the turn could not have proceeded whatever the user did, and the
 * reason is worth keeping. It loses the same way it loses for a scheduled run: the `202` told the
 * browser this turn was being stopped, so a row that then reads `FAILED` contradicts the answer the
 * user already has, while the user's own instruction is recorded nowhere else. The conflict message
 * makes it sharper still — it asks the user to send the message again, which is the opposite of
 * what somebody who has just pressed Stop wants to read.
 *
 * Most of these reasons survive the choice: a deleted chat and a lost claim are both on the worker
 * log, and a provisioning failure has written itself onto the workspace row with its reason. One
 * does not — a repository the operator has removed from the allow-list is refused before any row
 * exists and without a log line of its own, so cancelling drops that detail. Accepted knowingly:
 * the operator made that removal deliberately and the user asked for this turn to stop, so neither
 * of them learns anything from a turn row they were never going to read.
 *
 * Either way exactly one terminal event goes out, published before the row is finished, and none of
 * these paths reaches {@link settleTurn}, so no turn is finished twice.
 *
 * @param deps - Publisher and repositories.
 * @param turnId - The turn.
 * @param watch - The turn's cancellation subscription, open since before the first row was read.
 * @param code - Machine-readable failure code, recorded when no cancellation arrived.
 * @param message - Human-readable detail, recorded when no cancellation arrived.
 */
async function endUnstartedTurn(
  deps: ProcessorDeps,
  turnId: string,
  watch: CancellationWatch,
  code: string,
  message: string,
): Promise<void> {
  if (watch.requested()) {
    await cancelBeforeStart(deps, turnId);
    return;
  }
  await failTurn(deps, turnId, code, message);
}

/**
 * Runs the prepared turn to completion.
 *
 * @param deps - The processor's collaborators.
 * @param context - The turn being run.
 * @param watch - The cancellation subscription opened before preparation.
 * @throws Error When the Docker daemon is unreachable.
 */
async function runPreparedTurn(
  deps: ProcessorDeps,
  context: TurnContext,
  watch: CancellationWatch,
): Promise<void> {
  // The branch the prompt names and the branch the request carries are the same string, derived
  // by the same function the request builder uses. Naming the base branch here instead would tell
  // the agent to push to the branch the next sentence forbids it to push to.
  const workBranch = context.chat.workBranch ?? defaultWorkBranch(context.chat.id);
  const request = buildTurnRequest({
    turnId: context.turnId,
    model: deps.config.OPENAI_MODEL,
    instructions: buildTurnInstructions({
      repoUrl: context.chat.repoUrl,
      baseBranch: context.chat.baseBranch,
      workBranch,
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
    watch,
  });
  await finalizeTurn(deps, context, outcome);
  if (outcome.terminal === 'transport-error') {
    throw new Error('the workspace runner is unreachable');
  }
}

/**
 * Prepares and runs one turn, with the chat's workspace and the cancellation channel both held.
 *
 * The history is read after the stalled recovery, not before: the recovery appends the SYSTEM note
 * that tells the model its previous filesystem is gone, and a history read ahead of it would hand
 * the model everything except the one message explaining what happened.
 *
 * @param deps - The processor's collaborators.
 * @param delivery - The turn, its chat and how often it was delivered.
 * @param watch - The cancellation subscription, open since before preparation started.
 * @throws Error When the Docker daemon is unreachable, so BullMQ can redeliver the job.
 */
async function runWatchedTurn(
  deps: ProcessorDeps,
  delivery: TurnDelivery,
  watch: CancellationWatch,
): Promise<void> {
  const { turnId, chat } = delivery;
  await deps.repos.turns.setStatus(turnId, 'PREPARING');
  await recoverStalledWorkspace(deps, chat, delivery.attemptsMade);

  const messages = await deps.repos.messages.listByChat(chat.id);
  const ensured = await ensureWorkspace(deps, chat, messages);
  if (!ensured.ok) {
    // Preparing the workspace is the slow part the user watches, so it is where Stop is pressed.
    // The check just below already cancels a turn stopped while preparation succeeded; a Stop that
    // lands while preparation fails is the same request and gets the same record.
    await endUnstartedTurn(deps, turnId, watch, ensured.code, ensured.message);
    return;
  }
  await deps.repos.turns.setStatus(turnId, 'PREPARING', { workspaceId: ensured.workspace.id });
  if (watch.requested()) {
    await cancelBeforeStart(deps, turnId);
    return;
  }

  // Taking the workspace is a conditional write, and it is the last thing that happens before the
  // exec: the collector may have selected this row as idle while the workspace was being prepared,
  // and a second worker process would not see the in-process claim at all. `READY` is the only
  // status a turn may take a workspace from — a recovered stall has already been destroyed above,
  // and a `BUSY` row belongs to a turn that is running — so naming it here is what tells "I took
  // it" apart from "I overwrote whoever did". It comes after the Stop check because a turn
  // cancelled before its exec never reaches the release below.
  const busy = await deps.repos.workspaces.claimStatus(ensured.workspace.id, 'READY', 'BUSY');
  if (busy === null) {
    deps.logger.warn(
      { turnId, workspaceId: ensured.workspace.id },
      "another writer took this chat's workspace first",
    );
    await endUnstartedTurn(
      deps,
      turnId,
      watch,
      WORKSPACE_CONFLICT_CODE,
      WORKSPACE_CONFLICT_MESSAGE,
    );
    return;
  }

  const context: TurnContext = {
    turnId,
    chat,
    workspace: busy,
    handle: ensured.handle,
    decision: ensured.decision,
    messages,
  };
  try {
    await runPreparedTurn(deps, context, watch);
  } finally {
    await settleTurn(deps, turnId, context.workspace.id);
  }
}

/**
 * Runs one delivery of a turn whose execution this process now owns and whose channel it is
 * already listening on.
 *
 * Listening is only half of honouring it. Every branch from here down that ends a turn without
 * executing it — the chat is gone, another turn of the chat holds the workspace, the workspace
 * could not be prepared — asks the watch first, through {@link endUnstartedTurn}, so a Stop the
 * cancel route has already accepted decides the record rather than being outrun by the reason the
 * turn was not going to proceed anyway.
 *
 * @param deps - The processor's collaborators.
 * @param turnId - The turn named by the delivery.
 * @param attemptsMade - How many times BullMQ already delivered this job.
 * @param watch - The cancellation subscription, open since before the first row was read.
 * @throws Error When the Docker daemon is unreachable, so BullMQ can redeliver the job.
 */
async function runDeliveredTurn(
  deps: ProcessorDeps,
  turnId: string,
  attemptsMade: number,
  watch: CancellationWatch,
): Promise<void> {
  const turn = await deps.repos.turns.get(turnId);
  if (turn === null || isTerminalRunStatus(turn.status)) {
    deps.logger.warn({ turnId }, 'run-turn skipped: the turn is gone or already finished');
    return;
  }
  const chat = await deps.repos.chats.getById(turn.chatId);
  if (chat === null) {
    await endUnstartedTurn(
      deps,
      turnId,
      watch,
      'chat_not_found',
      'the chat this turn belongs to no longer exists',
    );
    return;
  }
  const claimKey = chatClaimKey(chat.id);
  if (!deps.claims.claim(claimKey)) {
    await endUnstartedTurn(
      deps,
      turnId,
      watch,
      WORKSPACE_CONFLICT_CODE,
      WORKSPACE_CONFLICT_MESSAGE,
    );
    return;
  }
  try {
    await runWatchedTurn(deps, { turnId, chat, attemptsMade }, watch);
  } finally {
    deps.claims.release(claimKey);
  }
}

/**
 * Builds the `run-turn` consumer.
 *
 * A chat's workspace is claimed for the whole turn. Two turns of one chat share a single
 * workspace, and a collection pass may be about to reclaim it; whichever of them takes the row
 * `BUSY` owns the container until it is done, and the others report a conflict rather than running
 * in a filesystem somebody else is writing to. That take is a conditional write, so it decides the
 * contention wherever the other writer is; the in-process claim above it only spares this worker
 * the work of preparing a turn it is about to lose.
 *
 * The turn itself is claimed too, and first. Stalled-job recovery can deliver a job a second time
 * while the first delivery is still executing it here, and that copy would otherwise lose the chat
 * claim to its own original and fail the very turn that is running — terminalising a row and a
 * stream the first delivery goes on writing to. A redelivery of a turn already in flight is
 * therefore acknowledged and left alone; only a different turn of the chat is refused.
 *
 * That refusal is the one place a Stop is deliberately not acted on here, and the order of the two
 * claims is what makes it safe: the turn claim is taken before the watch is opened, so a redelivery
 * that loses it has no subscription of its own to consult — and needs none, because the delivery
 * that holds the claim is listening on the same channel and will honour the request itself.
 *
 * @param deps - The processor's collaborators.
 * @returns A BullMQ processor for the `chat-turns` queue.
 */
export function createRunTurnProcessor(
  deps: ProcessorDeps,
): (job: ProcessorJob<RunTurnPayload>) => Promise<void> {
  return async (job: ProcessorJob<RunTurnPayload>): Promise<void> => {
    const { turnId } = runTurnPayload.parse(job.data);
    const turnKey = turnClaimKey(turnId);
    if (!deps.claims.claim(turnKey)) {
      deps.logger.warn({ turnId }, 'run-turn skipped: this turn is already running here');
      return;
    }
    try {
      // Before the first row is read, not after: the web app answers a cancellation it could not
      // apply itself by publishing on this channel, pub/sub keeps nothing for a subscriber that
      // has not arrived, and every lookup done before subscribing is time in which the request
      // reaches nobody while the caller is told the worker will act on it.
      const watch = await openCancellationWatch(deps, turnId);
      try {
        await runDeliveredTurn(deps, turnId, job.attemptsMade, watch);
      } finally {
        await watch.close();
      }
    } finally {
      deps.claims.release(turnKey);
    }
  };
}
