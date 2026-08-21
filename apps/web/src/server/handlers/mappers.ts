/**
 * Domain rows to API response shapes.
 *
 * Layer: service (server).
 *
 * Every mapper ends with the contract's own `.parse`, so a row that drifted away from the schema
 * fails here rather than reaching the UI as a shape it cannot render. That makes a response schema
 * as much a boundary as a request schema, which is the point: the rows are written by another
 * process and read back later, possibly across a migration.
 */
import {
  chatDetail,
  chatSummary,
  jobSummary,
  messageView,
  runDetail,
  runSummary,
  toolCallView,
  turnView,
  workspaceView,
} from '@agent-hangar/core';
import type {
  Chat,
  JobRun,
  Message,
  ScheduledJob,
  ToolCallLog,
  Turn,
  TurnStatus,
  Workspace,
} from '@agent-hangar/core';
import type { z } from 'zod';

/** Everything `GET /api/chats/:id` answers with. */
export interface ChatDetailInput {
  chat: Chat;
  messages: Message[];
  turns: Turn[];
  toolCalls: ToolCallLog[];
  workspace: Workspace | null;
}

/**
 * Serialises a date, keeping `null` as `null`.
 *
 * @param value - A timestamp or `null`.
 * @returns The ISO-8601 string, or `null`.
 */
function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * Maps a chat row onto the sidebar entry.
 *
 * @param chat - The chat row.
 * @param lastTurnStatus - Status of the most recent turn, or `null` when the chat has none.
 * @returns The parsed summary.
 * @throws ZodError When the row does not satisfy the contract.
 */
export function toChatSummary(
  chat: Chat,
  lastTurnStatus: TurnStatus | null,
): z.output<typeof chatSummary> {
  return chatSummary.parse({
    id: chat.id,
    title: chat.title,
    status: chat.status,
    repoUrl: chat.repoUrl,
    baseBranch: chat.baseBranch,
    workBranch: chat.workBranch,
    lastPushedSha: chat.lastPushedSha,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
    archivedAt: iso(chat.archivedAt),
    lastTurnStatus,
  });
}

/**
 * Reads the status of the most recent turn.
 *
 * @param turns - Turns of one chat, oldest first as the repository returns them.
 * @returns The last turn's status, or `null`.
 */
export function lastTurnStatus(turns: readonly Turn[]): TurnStatus | null {
  return turns.at(-1)?.status ?? null;
}

/**
 * Maps a message row.
 *
 * @param message - The message row.
 * @returns The parsed view.
 */
function toMessageView(message: Message): z.output<typeof messageView> {
  return messageView.parse({
    id: message.id,
    turnId: message.turnId,
    seq: message.seq,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  });
}

/**
 * Maps a turn row.
 *
 * @param turn - The turn row.
 * @returns The parsed view.
 */
function toTurnView(turn: Turn): z.output<typeof turnView> {
  return turnView.parse({
    id: turn.id,
    status: turn.status,
    model: turn.model,
    workspaceId: turn.workspaceId,
    usage: {
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      stepCount: turn.stepCount,
    },
    error: turn.error,
    preparedBranch: turn.preparedBranch,
    preparedSha: turn.preparedSha,
    queuedAt: turn.queuedAt.toISOString(),
    startedAt: iso(turn.startedAt),
    finishedAt: iso(turn.finishedAt),
  });
}

/**
 * Maps a tool-call log row; its arguments and result were redacted on write.
 *
 * @param call - The tool-call row.
 * @returns The parsed view.
 */
export function toToolCallView(call: ToolCallLog): z.output<typeof toolCallView> {
  return toolCallView.parse({
    id: call.id,
    turnId: call.turnId,
    jobRunId: call.jobRunId,
    callId: call.callId,
    seq: call.seq,
    toolName: call.toolName,
    args: call.args,
    resultHead: call.resultHead,
    resultBytes: call.resultBytes,
    exitCode: call.exitCode,
    status: call.status,
    startedAt: call.startedAt.toISOString(),
    finishedAt: iso(call.finishedAt),
    durationMs: call.durationMs,
  });
}

/**
 * Maps the live workspace of a chat.
 *
 * @param workspace - The workspace row, or `null`.
 * @returns The parsed view, or `null`.
 */
function toWorkspaceView(workspace: Workspace | null): z.output<typeof workspaceView> | null {
  return workspace === null
    ? null
    : workspaceView.parse({
        id: workspace.id,
        status: workspace.status,
        image: workspace.image,
        createdAt: workspace.createdAt.toISOString(),
        lastActiveAt: workspace.lastActiveAt.toISOString(),
      });
}

/**
 * Maps a whole chat with its history.
 *
 * @param input - Chat, messages, turns, tool calls and the live workspace.
 * @returns The parsed detail.
 * @throws ZodError When any row does not satisfy the contract.
 */
export function toChatDetail(input: ChatDetailInput): z.output<typeof chatDetail> {
  return chatDetail.parse({
    chat: toChatSummary(input.chat, lastTurnStatus(input.turns)),
    messages: input.messages.map(toMessageView),
    turns: input.turns.map(toTurnView),
    toolCalls: input.toolCalls.map(toToolCallView),
    workspace: toWorkspaceView(input.workspace),
  });
}

/**
 * Maps a scheduled-job row.
 *
 * @param job - The job row.
 * @param lastRunStatus - Status of the most recent run, or `null`.
 * @returns The parsed summary.
 */
export function toJobSummary(
  job: ScheduledJob,
  lastRunStatus: JobRun['status'] | null,
): z.output<typeof jobSummary> {
  return jobSummary.parse({
    id: job.id,
    name: job.name,
    cron: job.cron,
    timezone: job.timezone,
    prompt: job.prompt,
    repoUrl: job.repoUrl,
    branch: job.branch,
    enabled: job.enabled,
    lastRunAt: iso(job.lastRunAt),
    nextRunAt: iso(job.nextRunAt),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    lastRunStatus,
  });
}

/**
 * Maps a job-run row.
 *
 * @param run - The run row.
 * @returns The parsed summary.
 */
export function toRunSummary(run: JobRun): z.output<typeof runSummary> {
  return runSummary.parse({
    id: run.id,
    jobId: run.jobId,
    status: run.status,
    trigger: run.trigger,
    model: run.model,
    usage: {
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      stepCount: run.stepCount,
    },
    error: run.error,
    scheduledFor: run.scheduledFor.toISOString(),
    queuedAt: run.queuedAt.toISOString(),
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
  });
}

/**
 * Maps a job run with its output and tool calls.
 *
 * @param run - The run row.
 * @param toolCalls - Tool calls of that run, ascending by `seq`.
 * @returns The parsed detail.
 */
export function toRunDetail(
  run: JobRun,
  toolCalls: readonly ToolCallLog[],
): z.output<typeof runDetail> {
  return runDetail.parse({
    run: toRunSummary(run),
    output: run.output,
    // Both columns are written by the same statement, so one without the other is a row nothing
    // produces; the pair is still required together rather than assumed, because a half-filled
    // push would otherwise render a branch at commit `undefined`.
    push:
      run.workBranch === null || run.lastPushedSha === null
        ? null
        : { branch: run.workBranch, sha: run.lastPushedSha },
    toolCalls: toolCalls.map(toToolCallView),
  });
}
