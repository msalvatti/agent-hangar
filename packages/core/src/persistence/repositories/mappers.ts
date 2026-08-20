/**
 * Pure conversions between Prisma rows/enums and the domain types of `persistence/entities.ts`.
 *
 * Layer: service (persistence, pure).
 *
 * No I/O and no runtime import of the generated Prisma client: every Prisma-shaped input is a
 * type-only import, so this module stays trivially unit-testable. Domain entity fields are
 * already `T | null` (never optional), which happens to be exactly how Prisma represents a
 * nullable scalar, so row mappers are a direct field-by-field copy plus enum validation — no
 * `null` → `undefined` conversion is needed here.
 */

import type { SecretKey } from '../../secrets/types.ts';
import type {
  ChatStatus,
  JobRunStatus,
  JobRunTrigger,
  MessageRole,
  ToolCallStatus,
  TurnStatus,
  WorkspaceKind,
  WorkspaceStatus,
} from '../../workspace/types.ts';
import type {
  Chat,
  JobRun,
  Message,
  ScheduledJob,
  SecretRecord,
  ToolCallLog,
  Turn,
  Workspace,
} from '../entities.ts';
import type {
  Chat as ChatRow,
  JobRun as JobRunRow,
  Message as MessageRow,
  Prisma,
  ScheduledJob as ScheduledJobRow,
  Secret as SecretRow,
  ToolCallLog as ToolCallLogRow,
  Turn as TurnRow,
  Workspace as WorkspaceRow,
} from '../generated/client.ts';

import { PersistenceMappingError } from './errors.ts';

/**
 * Builds a validated converter for one enum: accepts any of `values` and returns it narrowed to
 * the literal union, or throws {@link PersistenceMappingError} for anything else.
 *
 * Domain unions and the Prisma-generated enums of this schema share the exact same string
 * literals, so the same guard doubles as the domain → Prisma direction (exported again under a
 * `toPrisma…` name for readability at call sites, per the lane's acceptance criteria).
 *
 * @param entity - Name used in the error message.
 * @param values - Every literal the union accepts.
 * @returns A function narrowing a `string` to `T`.
 */
function createEnumGuard<T extends string>(
  entity: string,
  values: readonly T[],
): (value: string) => T {
  const allowed = new Set<string>(values);
  return (value: string): T => {
    if (!allowed.has(value)) {
      throw new PersistenceMappingError(`Unknown ${entity} value: "${value}"`);
    }
    return value as T;
  };
}

/** Validates and narrows a `ChatStatus`; also the domain → Prisma direction (identity). */
export const asChatStatus = createEnumGuard<ChatStatus>('ChatStatus', ['ACTIVE', 'ARCHIVED']);
export const toPrismaChatStatus = asChatStatus;

/** Validates and narrows a `MessageRole`; also the domain → Prisma direction (identity). */
export const asMessageRole = createEnumGuard<MessageRole>('MessageRole', [
  'USER',
  'ASSISTANT',
  'SYSTEM',
  'TOOL_SUMMARY',
]);
export const toPrismaMessageRole = asMessageRole;

/** Validates and narrows a `TurnStatus`; also the domain → Prisma direction (identity). */
export const asTurnStatus = createEnumGuard<TurnStatus>('TurnStatus', [
  'QUEUED',
  'PREPARING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);
export const toPrismaTurnStatus = asTurnStatus;

/** Validates and narrows a `WorkspaceKind`; also the domain → Prisma direction (identity). */
export const asWorkspaceKind = createEnumGuard<WorkspaceKind>('WorkspaceKind', ['CHAT', 'JOB']);
export const toPrismaWorkspaceKind = asWorkspaceKind;

/** Validates and narrows a `WorkspaceStatus`; also the domain → Prisma direction (identity). */
export const asWorkspaceStatus = createEnumGuard<WorkspaceStatus>('WorkspaceStatus', [
  'CREATING',
  'READY',
  'BUSY',
  'STOPPING',
  'DESTROYED',
  'FAILED',
]);
export const toPrismaWorkspaceStatus = asWorkspaceStatus;

/** Validates and narrows a `JobRunStatus`; also the domain → Prisma direction (identity). */
export const asJobRunStatus = createEnumGuard<JobRunStatus>('JobRunStatus', [
  'QUEUED',
  'PREPARING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);
export const toPrismaJobRunStatus = asJobRunStatus;

/** Validates and narrows a `JobRunTrigger`; also the domain → Prisma direction (identity). */
export const asJobRunTrigger = createEnumGuard<JobRunTrigger>('JobRunTrigger', [
  'SCHEDULE',
  'MANUAL',
]);
export const toPrismaJobRunTrigger = asJobRunTrigger;

/** Validates and narrows a `ToolCallStatus`; also the domain → Prisma direction (identity). */
export const asToolCallStatus = createEnumGuard<ToolCallStatus>('ToolCallStatus', [
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
]);
export const toPrismaToolCallStatus = asToolCallStatus;

/** Validates and narrows a `SecretKey`; also the domain → Prisma direction (identity). */
export const asSecretKey = createEnumGuard<SecretKey>('SecretKey', [
  'GITHUB_PAT',
  'OPENAI_API_KEY',
]);
export const toPrismaSecretKey = asSecretKey;

/** Maps a `Chat` row to the domain type. */
export function toChat(row: ChatRow): Chat {
  return {
    id: row.id,
    title: row.title,
    status: asChatStatus(row.status),
    repoUrl: row.repoUrl,
    baseBranch: row.baseBranch,
    workBranch: row.workBranch,
    lastPushedSha: row.lastPushedSha,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  };
}

/** Maps a `Message` row to the domain type. */
export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    chatId: row.chatId,
    turnId: row.turnId,
    seq: row.seq,
    role: asMessageRole(row.role),
    content: row.content,
    createdAt: row.createdAt,
  };
}

/** Maps a `Turn` row to the domain type. */
export function toTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    chatId: row.chatId,
    workspaceId: row.workspaceId,
    status: asTurnStatus(row.status),
    model: row.model,
    queueJobId: row.queueJobId,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    stepCount: row.stepCount,
    error: row.error,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/** Maps a `Workspace` row to the domain type. */
export function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    kind: asWorkspaceKind(row.kind),
    status: asWorkspaceStatus(row.status),
    chatId: row.chatId,
    runnerKind: row.runnerKind,
    runnerRef: row.runnerRef,
    image: row.image,
    repoUrl: row.repoUrl,
    branch: row.branch,
    createdAt: row.createdAt,
    readyAt: row.readyAt,
    lastActiveAt: row.lastActiveAt,
    destroyedAt: row.destroyedAt,
    failureReason: row.failureReason,
  };
}

/** Maps a `ScheduledJob` row to the domain type. */
export function toScheduledJob(row: ScheduledJobRow): ScheduledJob {
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    repoUrl: row.repoUrl,
    branch: row.branch,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Maps a `JobRun` row to the domain type. */
export function toJobRun(row: JobRunRow): JobRun {
  return {
    id: row.id,
    jobId: row.jobId,
    workspaceId: row.workspaceId,
    status: asJobRunStatus(row.status),
    trigger: asJobRunTrigger(row.trigger),
    model: row.model,
    output: row.output,
    error: row.error,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    stepCount: row.stepCount,
    scheduledFor: row.scheduledFor,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/** Maps a `ToolCallLog` row to the domain type. */
export function toToolCallLog(row: ToolCallLogRow): ToolCallLog {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    turnId: row.turnId,
    jobRunId: row.jobRunId,
    callId: row.callId,
    seq: row.seq,
    toolName: row.toolName,
    args: row.args,
    resultHead: row.resultHead,
    resultBytes: row.resultBytes,
    exitCode: row.exitCode,
    status: asToolCallStatus(row.status),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
  };
}

/** Maps a `Secret` row to the domain type. Never touches plaintext: the columns are ciphertext. */
export function toSecretRecord(row: SecretRow): SecretRecord {
  return {
    key: asSecretKey(row.key),
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
    keyVersion: row.keyVersion,
    last4: row.last4,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Maximum size of `ToolCallLog.resultHead`, in UTF-8 bytes. */
export const RESULT_HEAD_MAX_BYTES = 8 * 1024;

/**
 * Truncates `text` to at most {@link RESULT_HEAD_MAX_BYTES} UTF-8 bytes without splitting a code
 * point and without appending any notice (the full length lives in `resultBytes`).
 *
 * @param text - Candidate `resultHead` value, already redacted.
 * @returns `text` unchanged when it already fits, otherwise the longest valid-UTF-8 prefix that
 *   fits the byte budget.
 */
export function truncateResultHead(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= RESULT_HEAD_MAX_BYTES) {
    return text;
  }
  // `encodeInto` fills the buffer with whole code points only and reports how many bytes it
  // wrote, so the cut is placed on a real UTF-8 boundary. Inspecting the decoded text instead
  // cannot tell a decoder-inserted U+FFFD from one the payload genuinely ends with, and would
  // drop that genuine character.
  const buffer = new Uint8Array(RESULT_HEAD_MAX_BYTES);
  const { written } = new TextEncoder().encodeInto(text, buffer);
  return new TextDecoder().decode(buffer.subarray(0, written));
}

/**
 * Narrows an arbitrary value to Prisma's `InputJsonValue` for a `Json` column.
 *
 * Goes through a `JSON.parse(JSON.stringify(...))` round trip, which is the only way to turn an
 * `unknown` into a JSON-safe value without a hand-rolled deep walk; the cost is that `undefined`
 * values nested in objects are dropped (JSON has no `undefined`) and non-JSON values (functions,
 * `Map`, `Set`, …) disappear or coerce, which is acceptable because tool-call `args` always
 * originates from a JSON-decoded model response.
 *
 * @param value - Value to store in a `Json` column (already redacted).
 * @returns A JSON-safe value Prisma accepts for that column.
 */
export function toInputJson(value: unknown): Prisma.InputJsonValue {
  const safe = value === undefined ? null : value;
  return JSON.parse(JSON.stringify(safe)) as Prisma.InputJsonValue;
}
