/**
 * Domain entity types returned by the repository ports (no Prisma types leak past the ports).
 *
 * Layer: contract.
 *
 * Shapes mirror the Prisma models one-to-one; enums are the string-literal unions of
 * `workspace/types.ts`; timestamps are `Date`s.
 */
import type { SecretEnvelope, SecretKey } from '../secrets/types.ts';
import type {
  ChatStatus,
  JobRunStatus,
  JobRunTrigger,
  MessageRole,
  ToolCallStatus,
  TurnStatus,
  WorkspaceKind,
  WorkspaceStatus,
} from '../workspace/types.ts';

/** A conversation bound to a repository and branch; carries the restore context. */
export interface Chat {
  id: string;
  title: string;
  status: ChatStatus;
  repoUrl: string;
  baseBranch: string;
  workBranch: string | null;
  lastPushedSha: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

/** One ordered entry of a chat's history. */
export interface Message {
  id: string;
  chatId: string;
  turnId: string | null;
  seq: number;
  role: MessageRole;
  content: string;
  createdAt: Date;
}

/** One user prompt → one agent execution in a workspace. */
export interface Turn {
  id: string;
  chatId: string;
  workspaceId: string | null;
  status: TurnStatus;
  model: string;
  queueJobId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  stepCount: number;
  error: string | null;
  /** Branch the workspace was prepared on, once it has been; `null` before that. */
  preparedBranch: string | null;
  /** Commit the workspace was prepared at, once it has been; `null` before that. */
  preparedSha: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** Metadata about a container; never holds state needed for restore. */
export interface Workspace {
  id: string;
  kind: WorkspaceKind;
  status: WorkspaceStatus;
  chatId: string | null;
  runnerKind: string;
  runnerRef: string | null;
  image: string;
  repoUrl: string;
  branch: string;
  createdAt: Date;
  readyAt: Date | null;
  lastActiveAt: Date;
  destroyedAt: Date | null;
  failureReason: string | null;
}

/** Cron definition + prompt + repo/branch + enabled flag. */
export interface ScheduledJob {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  repoUrl: string;
  branch: string;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One execution of a scheduled job in a fresh workspace. */
export interface JobRun {
  id: string;
  jobId: string;
  workspaceId: string | null;
  status: JobRunStatus;
  trigger: JobRunTrigger;
  model: string;
  output: string | null;
  error: string | null;
  /**
   * Branch the run pushed to, as git reported it after the push; `null` when it pushed nothing.
   *
   * A run has no message channel and no restore, so this is not a hint for rebuilding anything —
   * it is the record of where the run's work ended up. Its container is destroyed the moment the
   * run finishes and its event stream is discarded an hour later, so without these two columns the
   * one durable fact a coding job exists to produce is not recoverable from the application at all.
   */
  workBranch: string | null;
  /** Commit at the head of {@link JobRun.workBranch} after that push; `null` when it pushed nothing. */
  lastPushedSha: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  stepCount: number;
  scheduledFor: Date;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** Every tool call executed by the agent, with redacted arguments and a truncated result. */
export interface ToolCallLog {
  id: string;
  workspaceId: string;
  turnId: string | null;
  jobRunId: string | null;
  callId: string;
  seq: number;
  toolName: string;
  args: unknown;
  resultHead: string | null;
  resultBytes: number | null;
  exitCode: number | null;
  status: ToolCallStatus;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
}

/** Stored secret row: the envelope plus bookkeeping. Never contains plaintext. */
export interface SecretRecord extends SecretEnvelope {
  key: SecretKey;
  createdAt: Date;
  updatedAt: Date;
}

/** Token usage recorded when a turn or run finishes. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  stepCount: number;
}
