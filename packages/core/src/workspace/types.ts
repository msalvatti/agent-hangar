/**
 * Domain lifecycle states (string-literal mirrors of the Prisma enums) and restore contracts.
 *
 * Layer: contract.
 *
 * Prisma enums exist only in `schema.prisma`; repositories map them to these unions at the
 * persistence boundary so no Prisma type leaks into domain code.
 */

/** Lifecycle of a chat. */
export type ChatStatus = 'ACTIVE' | 'ARCHIVED';

/** Author of a message in the ordered history. */
export type MessageRole = 'USER' | 'ASSISTANT' | 'SYSTEM' | 'TOOL_SUMMARY';

/** Lifecycle of a chat turn. */
export type TurnStatus = 'QUEUED' | 'PREPARING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** What a workspace serves. */
export type WorkspaceKind = 'CHAT' | 'JOB';

/** Lifecycle of a workspace container. */
export type WorkspaceStatus = 'CREATING' | 'READY' | 'BUSY' | 'STOPPING' | 'DESTROYED' | 'FAILED';

/** Workspace statuses that count as "live" (at most one per chat). */
export const LIVE_WORKSPACE_STATUSES: readonly WorkspaceStatus[] = [
  'CREATING',
  'READY',
  'BUSY',
  'STOPPING',
];

/** Lifecycle of a scheduled job run. */
export type JobRunStatus =
  'QUEUED' | 'PREPARING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** What started a job run. */
export type JobRunTrigger = 'SCHEDULE' | 'MANUAL';

/** Lifecycle of a logged tool call. */
export type ToolCallStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';

/** One message of the ordered history used to rebuild a turn's model input. */
export interface RestoreMessage {
  /** Monotonic, gap-free position within the chat. */
  seq: number;
  role: MessageRole;
  /** Already redacted. */
  content: string;
}

/**
 * Everything persisted in Postgres that a fresh workspace needs to continue a chat faithfully.
 *
 * The container filesystem, shell history and installed dependencies are deliberately not part
 * of it; the agent re-installs as needed.
 */
export interface RestoreContext {
  /** `https://github.com/owner/repo`, credential-free. */
  repoUrl: string;
  /** Branch chosen at chat creation; used for `git clone --branch`. */
  baseBranch: string;
  /** Branch the agent pushes to; checked out after clone when present. */
  workBranch: string | null;
  /** Last commit the agent pushed; HEAD is verified against it after checkout. */
  lastPushedSha: string | null;
  /** Ordered history (USER, ASSISTANT, SYSTEM, TOOL_SUMMARY), windowed by the restore builder. */
  messages: readonly RestoreMessage[];
  /** When the previous workspace disappeared; drives the restoration notice. */
  restoredAt: Date;
}

/** Outcome of the worker's "ensure workspace" step before a turn runs. */
export type EnsureWorkspaceDecision =
  | { action: 'reuse'; workspaceId: string }
  | { action: 'create'; clone: true; restore: RestoreContext };
