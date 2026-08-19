/**
 * Domain entity types returned by the repository ports (no Prisma types leak past the ports).
 *
 * Layer: contract.
 *
 * Shapes mirror the Prisma models one-to-one; enums are the string-literal unions of
 * `workspace/types.ts`; timestamps are `Date`s.
 */
import type { SecretEnvelope, SecretKey } from '../secrets/types.js';
import type {
  ChatStatus,
  JobRunStatus,
  JobRunTrigger,
  MessageRole,
  ToolCallStatus,
  TurnStatus,
  WorkspaceKind,
  WorkspaceStatus,
} from '../workspace/types.js';

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
