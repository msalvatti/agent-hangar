/**
 * Lifecycle state machines for workspaces and for the runs that use them.
 *
 * Layer: domain (pure).
 *
 * Every status write in the persistence layer and every processor in the worker goes through
 * these tables, so an impossible transition — resurrecting a destroyed container, finishing a run
 * that never started — fails loudly at the boundary instead of leaving a row the UI cannot
 * explain. Self-transitions are absent from every list on purpose: writing the status a row
 * already has is a lost-update bug, not a no-op.
 */
import { IllegalTransitionError } from '../errors.ts';

import { LIVE_WORKSPACE_STATUSES } from './types.ts';
import type { JobRunStatus, TurnStatus, WorkspaceStatus } from './types.ts';

/** Statuses a chat turn and a scheduled job run share; the two unions are identical by design. */
export type RunStatus = TurnStatus;

/** Allowed successor states per state, exhaustive over the union so a new state cannot be missed. */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

/**
 * Allowed workspace transitions.
 *
 * `CREATING` may fail or be abandoned before it is ever ready; a `READY` workspace becomes `BUSY`
 * for the duration of a turn and returns; `DESTROYED` is final because the container and its
 * storage are gone.
 */
export const WORKSPACE_TRANSITIONS: TransitionTable<WorkspaceStatus> = {
  CREATING: ['READY', 'FAILED', 'DESTROYED'],
  READY: ['BUSY', 'STOPPING', 'DESTROYED', 'FAILED'],
  BUSY: ['READY', 'STOPPING', 'FAILED', 'DESTROYED'],
  STOPPING: ['DESTROYED', 'FAILED'],
  FAILED: ['DESTROYED'],
  DESTROYED: [],
};

/**
 * Allowed transitions of a chat turn or a scheduled job run.
 *
 * The intersection of both table types is the compile-time proof that `TurnStatus` and
 * `JobRunStatus` still describe the same lifecycle: if either union gained a state, this literal
 * would be missing a key.
 */
export const RUN_TRANSITIONS: TransitionTable<RunStatus> & TransitionTable<JobRunStatus> = {
  QUEUED: ['PREPARING', 'FAILED', 'CANCELLED'],
  PREPARING: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

/**
 * Reports whether a workspace status counts as live.
 *
 * Live is the set the partial unique index on `Workspace(chatId)` uses, so at most one live
 * workspace can exist per chat.
 *
 * @param status - Status to classify.
 * @returns `true` for `CREATING`, `READY`, `BUSY` and `STOPPING`.
 */
export function isLiveWorkspaceStatus(status: WorkspaceStatus): boolean {
  return LIVE_WORKSPACE_STATUSES.includes(status);
}

/**
 * Reports whether a run status is terminal.
 *
 * @param status - Status to classify.
 * @returns `true` when no further transition is allowed.
 */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return RUN_TRANSITIONS[status].length === 0;
}

/**
 * Reports whether a table allows a transition.
 *
 * @param table - Transition table to consult.
 * @param from - Current state.
 * @param to - Requested state.
 * @returns `true` when the table lists `to` as a successor of `from`.
 */
export function canTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  return table[from].includes(to);
}

/**
 * Enforces a transition.
 *
 * @param table - Transition table to consult.
 * @param from - Current state.
 * @param to - Requested state.
 * @param subject - What is transitioning, e.g. `workspace ws-1`; quoted in the error.
 * @throws IllegalTransitionError When the table does not allow the transition.
 */
export function assertTransition<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
  subject: string,
): void {
  if (!canTransition(table, from, to)) {
    throw new IllegalTransitionError(subject, from, to);
  }
}

/**
 * Enforces a workspace transition.
 *
 * @param from - Current status.
 * @param to - Requested status.
 * @param workspaceId - `Workspace.id`, named in the error.
 * @throws IllegalTransitionError When the transition is not allowed.
 */
export function assertWorkspaceTransition(
  from: WorkspaceStatus,
  to: WorkspaceStatus,
  workspaceId: string,
): void {
  assertTransition(WORKSPACE_TRANSITIONS, from, to, `workspace ${workspaceId}`);
}

/**
 * Enforces a turn or job-run transition.
 *
 * @param from - Current status.
 * @param to - Requested status.
 * @param runId - `Turn.id` or `JobRun.id`, named in the error.
 * @throws IllegalTransitionError When the transition is not allowed.
 */
export function assertRunTransition(from: RunStatus, to: RunStatus, runId: string): void {
  assertTransition(RUN_TRANSITIONS, from, to, `run ${runId}`);
}

/**
 * Fails on a value the type system proved impossible.
 *
 * Reached only when a value crosses a boundary untyped — a database column holding a status this
 * build does not know, for instance — so it reports the value rather than falling through.
 *
 * @param value - The value that should have been `never`.
 * @throws RangeError Always.
 */
export function assertNever(value: never): never {
  throw new RangeError(`unhandled case: ${JSON.stringify(value)}`);
}
