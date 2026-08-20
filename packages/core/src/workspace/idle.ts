/**
 * Idle-workspace selection for the garbage collector.
 *
 * Layer: domain (pure).
 *
 * Containers are cattle: one left running after a chat goes quiet costs memory for nothing, and
 * the chat loses nothing by being recreated from history on its next message. The collector runs
 * every five minutes and reaps what this module selects.
 */
import type { WorkspaceKind, WorkspaceStatus } from './types.ts';

/** Milliseconds in a minute; the TTL is configured in minutes. */
const MINUTE_MS = 60_000;

/** What the selector needs to know about a candidate workspace. */
export interface IdleCandidate {
  /** `Workspace.id`. */
  id: string;
  status: WorkspaceStatus;
  kind: WorkspaceKind;
  /** Last time a turn touched the workspace. */
  lastActiveAt: Date;
}

/**
 * Computes the instant before which a workspace counts as idle.
 *
 * @param now - Current instant, injected so the collector stays testable.
 * @param idleTtlMin - `WORKSPACE_IDLE_TTL_MIN`, in minutes.
 * @returns `now` minus the TTL.
 * @throws RangeError When the TTL is not positive; a zero or negative TTL would reap workspaces
 *   that are still in use.
 */
export function idleCutoff(now: Date, idleTtlMin: number): Date {
  if (idleTtlMin <= 0) {
    throw new RangeError(`idleTtlMin must be positive, got ${idleTtlMin}`);
  }
  return new Date(now.getTime() - idleTtlMin * MINUTE_MS);
}

/**
 * Selects the workspaces the collector should destroy.
 *
 * Only `READY` workspaces qualify: `BUSY` is running a turn, and `CREATING` and `STOPPING` are
 * transient states another actor owns. Both kinds qualify — a job workspace that outlived its run
 * is a leak, and reaping it is exactly the intended repair.
 *
 * @param candidates - Workspaces to consider, typically every live row.
 * @param opts - Current instant and the configured TTL in minutes.
 * @returns Ids of the idle workspaces, oldest first, then by id so the order is stable.
 * @throws RangeError When the TTL is not positive.
 */
export function selectIdleWorkspaces(
  candidates: readonly IdleCandidate[],
  opts: { now: Date; idleTtlMin: number },
): string[] {
  const cutoff = idleCutoff(opts.now, opts.idleTtlMin);
  return candidates
    .filter(
      (candidate) =>
        candidate.status === 'READY' && candidate.lastActiveAt.getTime() < cutoff.getTime(),
    )
    .toSorted(
      (left, right) =>
        left.lastActiveAt.getTime() - right.lastActiveAt.getTime() ||
        left.id.localeCompare(right.id),
    )
    .map((candidate) => candidate.id);
}
