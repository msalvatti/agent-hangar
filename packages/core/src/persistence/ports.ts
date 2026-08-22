/**
 * Repository ports: the only way domain code reads or writes durable state.
 *
 * Layer: service (port).
 *
 * Inputs and outputs are domain types from `./entities.ts`; Prisma types never cross this
 * boundary. Repositories are the only writers and redact every free-text column on write.
 * Every method resolves with the fresh row it produced so callers never re-query.
 *
 * Writes come in two shapes. An unconditional one — `setStatus` and its siblings — overwrites
 * whatever the row currently holds, which is right when the caller is the only writer of that row.
 * A conditional one names the status the caller read and resolves with `null` when the row is no
 * longer in it, which is the only way a caller can find out that somebody else moved the row
 * between its read and its write. Two writers of one row must use the conditional shape: the
 * unconditional one cannot tell "I moved it" from "I overwrote what somebody else moved it to".
 */
import type { SecretEnvelope, SecretKey, SecretStatus } from '../secrets/types.ts';
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

import type {
  Chat,
  JobRun,
  Message,
  ScheduledJob,
  SecretRecord,
  ToolCallLog,
  Turn,
  UsageTotals,
  Workspace,
} from './entities.ts';

/** Fields needed to create a chat. */
export interface CreateChatInput {
  title: string;
  repoUrl: string;
  baseBranch: string;
}

/**
 * What a conditional chat delete did.
 *
 * `LIVE_TURN` and `MISSING` are kept apart because the caller answers them differently — one is a
 * refusal the user can act on, the other is the outcome the request asked for reached by somebody
 * else — where a workspace claim can collapse both into `null` because neither lets the caller act.
 */
export type ChatDeleteOutcome = 'DELETED' | 'LIVE_TURN' | 'MISSING';

/** Restore hints written when the agent pushes. */
export interface RestoreHints {
  workBranch?: string | null;
  lastPushedSha?: string | null;
}

/** Chat rows. */
export interface ChatRepository {
  /** Creates an `ACTIVE` chat. */
  create(input: CreateChatInput): Promise<Chat>;
  /** Returns the chat or `null` when it does not exist. */
  getById(id: string): Promise<Chat | null>;
  /** Lists chats, most recently updated first; all statuses when `status` is omitted. */
  list(status?: ChatStatus): Promise<Chat[]>;
  /** Renames the chat (title is editable inline in the header). */
  rename(id: string, title: string): Promise<Chat>;
  /** Sets the status; `ARCHIVED` stamps `archivedAt`, `ACTIVE` clears it. */
  setStatus(id: string, status: ChatStatus): Promise<Chat>;
  /** Updates `workBranch` / `lastPushedSha`; omitted fields are untouched. */
  updateRestoreHints(id: string, hints: RestoreHints): Promise<Chat>;
  /** Bumps `updatedAt` (sidebar ordering). */
  touch(id: string): Promise<void>;
  /**
   * Deletes the chat and, by cascade, its messages, turns and tool-call logs — but only while the
   * chat carries no live turn.
   *
   * The precondition is part of the write rather than a check the caller makes first, which is the
   * whole of what this method offers. A request that reads the turns and then deletes leaves a
   * window in which another request can claim the chat's work slot, and the cascade then removes a
   * turn that request was told it owned; naming the condition in the delete itself hands that
   * decision to the database, so the claim and the delete cannot both succeed.
   *
   * @param id - Chat to delete.
   * @returns `DELETED` when the row and everything under it are gone, `LIVE_TURN` when a turn of
   *   the chat is queued or executing, `MISSING` when there is no such chat.
   */
  deleteIfIdle(id: string): Promise<ChatDeleteOutcome>;
}

/** Paging options for message history, ascending by `seq`. */
export interface ListMessagesOptions {
  /** Maximum number of messages; the most recent ones are returned when it cuts. */
  limit?: number;
  /** Only messages with `seq` strictly lower than this value. */
  before?: number;
}

/** Message rows; `seq` is assigned gap-free per chat inside a transaction. */
export interface MessageRepository {
  /** Appends a message with the next `seq` of the chat; content is redacted on write. */
  append(chatId: string, role: MessageRole, content: string, turnId?: string): Promise<Message>;
  /** Ordered history of a chat, ascending by `seq`. */
  listByChat(chatId: string, options?: ListMessagesOptions): Promise<Message[]>;
}

/** Fields needed to create a turn. */
export interface CreateTurnInput {
  chatId: string;
  model: string;
  queueJobId?: string;
}

/** Optional fields written together with a turn status change. */
export interface TurnStatusUpdate {
  workspaceId?: string | null;
  queueJobId?: string | null;
  /** Redacted on write. */
  error?: string | null;
}

/** Terminal statuses of a turn or run. */
export type TerminalStatus = 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** Turn rows. */
export interface TurnRepository {
  /** Creates a `QUEUED` turn. */
  create(input: CreateTurnInput): Promise<Turn>;
  /** Sets the status; `PREPARING` stamps `startedAt` when unset. */
  setStatus(id: string, status: TurnStatus, update?: TurnStatusUpdate): Promise<Turn>;
  /** Returns the turn or `null`. */
  get(id: string): Promise<Turn | null>;
  /**
   * Sets a terminal status, usage and `finishedAt`, but only while the turn has not reached one
   * already; `error` is redacted on write.
   *
   * The condition is part of the write rather than a check the caller makes first, so the first
   * writer of an outcome is the one that is kept and every later one is told it lost. Two writers
   * genuinely compete for this: the worker records what the run did, and the cancel route records
   * what the user asked for, and each decides from a status it read some awaits earlier. An
   * unconditional write let the later of them overwrite the earlier — which is how a cancellation
   * the API had already accepted, and reported to the browser, ended up stored as a failure.
   *
   * @param id - Turn to finish.
   * @param status - Terminal status to record.
   * @param usage - Token and step totals.
   * @param error - Failure detail, redacted on write.
   * @returns The finished turn, or `null` when nothing was recorded — because the turn had already
   *   reached a terminal status, or because there is no such row.
   */
  finish(
    id: string,
    status: TerminalStatus,
    usage: UsageTotals,
    error?: string,
  ): Promise<Turn | null>;
  /**
   * Moves a `FAILED` turn back to `QUEUED` so it can be dispatched again, erasing the record of
   * the attempt that failed: `error`, `startedAt`, `finishedAt` and the usage totals are all
   * cleared. Only `FAILED` is a legal source — every other status either has work behind it or
   * describes an outcome nobody asked to undo.
   *
   * The condition is part of the write rather than a check the caller makes first, so two
   * concurrent retries of one turn cannot both see `FAILED` and both proceed.
   *
   * @param id - Turn to requeue.
   * @returns The requeued turn, or `null` when it was not requeued — because no such row exists,
   *   or because the row is not `FAILED`. Callers that have already resolved the turn can only
   *   see the second reason.
   */
  requeue(id: string): Promise<Turn | null>;
  /**
   * Records what the workspace of this turn was prepared on.
   *
   * Written rather than published only, because the transcript states it and a reload has nothing
   * else to state it from: the preparation is an event, and events are not kept. It is not a
   * SYSTEM message for the reason `run-turn` gives about the rest of them — a message is part of
   * the window a later turn carries to the model, and this describes a container the turn does not
   * outlive.
   *
   * @param id - Turn the workspace belongs to.
   * @param prepared - Branch and commit the workspace was put on.
   * @returns Nothing; a turn that has vanished is not an error worth failing the run over.
   */
  recordPrepared(id: string, prepared: { branch: string; headSha: string }): Promise<void>;
  /** Turns of a chat, oldest first. */
  listByChat(chatId: string): Promise<Turn[]>;
}

/** Fields needed to create a workspace row. */
export interface CreateWorkspaceInput {
  kind: WorkspaceKind;
  chatId?: string;
  runnerKind: string;
  image: string;
  repoUrl: string;
  branch: string;
}

/** Optional fields written together with a workspace status change. */
export interface WorkspaceStatusUpdate {
  runnerRef?: string | null;
  /** Redacted on write. */
  failureReason?: string | null;
}

/** Workspace rows; at most one live workspace per chat. */
export interface WorkspaceRepository {
  /**
   * Creates a `CREATING` workspace.
   *
   * @throws LiveWorkspaceExistsError when the chat already has a live workspace.
   */
  create(input: CreateWorkspaceInput): Promise<Workspace>;
  /** The live (`CREATING`/`READY`/`BUSY`/`STOPPING`) workspace of a chat, or `null`. */
  findLiveByChat(chatId: string): Promise<Workspace | null>;
  /** Sets the status; `READY` stamps `readyAt` when unset, `DESTROYED` stamps `destroyedAt`. */
  setStatus(
    id: string,
    status: WorkspaceStatus,
    update?: WorkspaceStatusUpdate,
  ): Promise<Workspace>;
  /**
   * Moves a workspace out of the status the caller read, in one conditional write.
   *
   * The turn processor and the workspace collector both decide from a row they read earlier, and
   * either can act between the other's read and its write. This is what lets them arbitrate: the
   * expected status is part of the write, so exactly one of two writers moves the row and the
   * other is told it lost, instead of overwriting a state it never saw.
   *
   * Stamps the same timestamps as {@link setStatus} and applies the same optional fields, so a
   * caller that switches from one to the other changes only what happens when it loses.
   *
   * The move must be one the workspace lifecycle allows, which rules out `from === to`: a row that
   * never leaves its status has not been moved by anybody, so every concurrent caller would be told
   * it won and the guarantee above would be false. That is refused rather than answered `null`,
   * because it is a caller naming an impossible move rather than a caller losing a race — the two
   * deserve different answers. `setStatus` makes no such promise and enforces no such rule; this
   * method does, because arbitration is the whole of what it offers.
   *
   * @param id - Workspace to move.
   * @param from - Status the caller read; the write applies only while the row still holds it.
   * @param to - Status to write; must be a successor of `from`.
   * @param update - Same optional columns {@link setStatus} accepts.
   * @returns The row this call produced, or `null` when it no longer held `from` — because
   *   another writer moved it, or because it does not exist.
   * @throws IllegalTransitionError When the workspace lifecycle does not allow `from` to `to`,
   *   self-transitions included.
   */
  claimStatus(
    id: string,
    from: WorkspaceStatus,
    to: WorkspaceStatus,
    update?: WorkspaceStatusUpdate,
  ): Promise<Workspace | null>;
  /** Bumps `lastActiveAt` (idle-TTL clock). */
  markActive(id: string): Promise<void>;
  /** `READY` workspaces whose `lastActiveAt` is before `before` (idle GC candidates). */
  listIdle(before: Date): Promise<Workspace[]>;
  /** Every live workspace (orphan reconciliation, doctor). */
  listLive(): Promise<Workspace[]>;
  /** Returns the workspace or `null`. */
  get(id: string): Promise<Workspace | null>;
}

/** Fields needed to create a scheduled job. */
export interface CreateScheduledJobInput {
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  repoUrl: string;
  branch: string;
  enabled: boolean;
  nextRunAt?: Date | null;
}

/** Fields that can be edited on a scheduled job. */
export type UpdateScheduledJobInput = Partial<CreateScheduledJobInput>;

/** Run timestamps maintained by the worker. */
export interface RunTimes {
  lastRunAt?: Date | null;
  nextRunAt?: Date | null;
}

/** Scheduled job rows. */
export interface ScheduledJobRepository {
  /** Creates a job. */
  create(input: CreateScheduledJobInput): Promise<ScheduledJob>;
  /** Returns the job or `null`. */
  get(id: string): Promise<ScheduledJob | null>;
  /** Every job, newest first. */
  list(): Promise<ScheduledJob[]>;
  /** Applies a partial edit. */
  update(id: string, patch: UpdateScheduledJobInput): Promise<ScheduledJob>;
  /** Deletes the job and, by cascade, its runs. */
  delete(id: string): Promise<void>;
  /** Enabled jobs (scheduler reconciliation). */
  listEnabled(): Promise<ScheduledJob[]>;
  /** Updates `lastRunAt` / `nextRunAt`; omitted fields are untouched. */
  setRunTimes(id: string, times: RunTimes): Promise<ScheduledJob>;
}

/** Fields needed to create a job run. */
export interface CreateJobRunInput {
  jobId: string;
  trigger: JobRunTrigger;
  model: string;
  /** The cron tick this run belongs to (now, for manual runs). */
  scheduledFor: Date;
}

/**
 * Kind of workspace a `JobRun` may point at.
 *
 * A run gets a container of its own and destroys it when it ends, so the reference has to name a
 * workspace built for that. A chat's workspace is the opposite: shared by every turn of the chat
 * and expected to survive them, so a run pointed at one would destroy a filesystem still in use.
 * Every implementation of {@link JobRunRepository} refuses the reference, and refuses it the same
 * way — a rule only one of them enforced would hold exactly in the runs nobody watches.
 */
export const JOB_RUN_WORKSPACE_KIND: WorkspaceKind = 'JOB';

/** Optional fields written together with a run status change. */
export interface JobRunStatusUpdate {
  /**
   * Unique across runs: a run never reuses a workspace.
   *
   * Must name a {@link JOB_RUN_WORKSPACE_KIND} workspace; anything else is refused with
   * `WorkspaceKindMismatchError`, and an id no workspace carries with `NotFoundError`.
   */
  workspaceId?: string | null;
  /** Redacted on write. */
  error?: string | null;
}

/** Final state of a job run. */
export interface FinishJobRunInput {
  status: TerminalStatus;
  usage: UsageTotals;
  /** Final assistant message, redacted on write. */
  output?: string | null;
  /** Redacted on write. */
  error?: string | null;
}

/** Where a run's work ended up, as git reported it after the push. */
export interface JobRunPush {
  /** Branch the push landed on. */
  workBranch: string;
  /** Commit at that branch's head. */
  lastPushedSha: string;
}

/** Job run rows. */
export interface JobRunRepository {
  /** Creates a `QUEUED` run. */
  create(input: CreateJobRunInput): Promise<JobRun>;
  /**
   * Records where the run pushed, overwriting whatever an earlier push of the same run recorded.
   *
   * A run may push more than once, and the last push is the one that describes the branch as it
   * stands, which is what the run's record is for. Unlike a chat's restore hints, nothing is ever
   * rebuilt from this: a run always starts in a fresh workspace from the job's prompt.
   *
   * @param id - Run that pushed.
   * @param push - Branch and commit git reported.
   * @returns The updated run.
   * @throws NotFoundError When no run carries that id.
   */
  recordPush(id: string, push: JobRunPush): Promise<JobRun>;
  /** Sets the status; `PREPARING` stamps `startedAt` when unset. */
  setStatus(id: string, status: JobRunStatus, update?: JobRunStatusUpdate): Promise<JobRun>;
  /**
   * Sets a terminal status, output/error, usage and `finishedAt`, but only while the run has not
   * reached one already.
   *
   * Same rule, and the same reason, as {@link TurnRepository.finish}: the worker and the cancel
   * route both write an outcome for a run they read a moment earlier, and exactly one of them may
   * be the record.
   *
   * @param id - Run to finish.
   * @param input - Terminal status, totals and the text to store.
   * @returns The finished run, or `null` when nothing was recorded — because the run had already
   *   reached a terminal status, or because there is no such row.
   */
  finish(id: string, input: FinishJobRunInput): Promise<JobRun | null>;
  /** Runs of a job, newest first. */
  listByJob(jobId: string, options?: { limit?: number }): Promise<JobRun[]>;
  /** Returns the run or `null`. */
  get(id: string): Promise<JobRun | null>;
  /** The `PREPARING`/`RUNNING` run of a job, or `null` (overlap policy). */
  findRunningByJob(jobId: string): Promise<JobRun | null>;
}

/** Fields recorded when a tool call starts. Exactly one of `turnId`/`jobRunId` is set. */
export interface StartToolCallInput {
  workspaceId: string;
  turnId?: string;
  jobRunId?: string;
  callId: string;
  seq: number;
  toolName: string;
  /** Redacted on write. */
  args: unknown;
}

/** Fields recorded when a tool call finishes. */
export interface FinishToolCallInput {
  status: Exclude<ToolCallStatus, 'RUNNING'>;
  exitCode: number | null;
  /** First 8 KB of the result, redacted on write. */
  resultHead: string | null;
  /** Full length of the result. */
  resultBytes: number | null;
  durationMs: number;
}

/** Tool-call log rows. */
export interface ToolCallLogRepository {
  /** Records a `RUNNING` tool call. */
  start(input: StartToolCallInput): Promise<ToolCallLog>;
  /** Records the outcome and `finishedAt`. */
  finish(id: string, input: FinishToolCallInput): Promise<ToolCallLog>;
  /** Tool calls of a turn, ascending by `seq`. */
  listByTurn(turnId: string): Promise<ToolCallLog[]>;
  /** Tool calls of a job run, ascending by `seq`. */
  listByJobRun(jobRunId: string): Promise<ToolCallLog[]>;
}

/** Secret rows; one per key, append-or-replace. */
export interface SecretRepository {
  /** Inserts or replaces the envelope for a key. */
  upsert(key: SecretKey, envelope: SecretEnvelope): Promise<void>;
  /** Returns the stored envelope or `null`. */
  get(key: SecretKey): Promise<SecretRecord | null>;
  /** Deletes the row; no-op when absent. */
  remove(key: SecretKey): Promise<void>;
  /** Masked status of every key. */
  status(): Promise<Record<SecretKey, SecretStatus>>;
}

/** All repositories, as wired by the composition root. */
export interface Repositories {
  chats: ChatRepository;
  messages: MessageRepository;
  turns: TurnRepository;
  workspaces: WorkspaceRepository;
  scheduledJobs: ScheduledJobRepository;
  jobRuns: JobRunRepository;
  toolCalls: ToolCallLogRepository;
  secrets: SecretRepository;
}
