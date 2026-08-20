/**
 * Reconciliation of running containers against live workspace rows.
 *
 * Layer: domain (pure).
 *
 * The runner and the database can disagree in both directions: a worker that dies between
 * `create` and the row update leaves a container nothing points at, and a container removed by
 * hand (or by a Docker restart) leaves a row claiming a workspace that is gone. The collector
 * runs this diff on every tick and on boot.
 */
import type { WorkspaceHandle } from '../runner/types.ts';

/** Both sides of the comparison: what the runner lists and what the database calls live. */
export interface OrphanReconcileInput {
  /** Handles reported by `WorkspaceRunner.list` for this instance's label selector. */
  runnerHandles: readonly WorkspaceHandle[];
  /** Live workspace rows. */
  dbLive: readonly { id: string; runnerRef: string | null }[];
}

/** What the collector must do to bring the two sides back together. */
export interface OrphanReconcilePlan {
  /** Containers with no live row: destroy them, they belong to nothing. */
  destroyOrphans: WorkspaceHandle[];
  /** Ids of live rows with no container: the workspace is gone and the row must be closed out. */
  markGone: string[];
}

/**
 * Diffs running containers against live workspace rows.
 *
 * Matching is by `workspaceId`, not by `runnerRef`: the id is assigned before the container
 * exists, so it is the only identifier both sides always agree on.
 *
 * Classification only — the caller destroys each orphan handle, and decides whether a `markGone`
 * row becomes `FAILED` with a reason or `DESTROYED`, which depends on what it was doing.
 *
 * @param input - Runner handles and live rows.
 * @returns Orphan handles and gone row ids, each ordered by id for a stable, diffable plan.
 */
export function planOrphanReconcile(input: OrphanReconcileInput): OrphanReconcilePlan {
  const liveIds = new Set(input.dbLive.map((row) => row.id));
  const runningIds = new Set(input.runnerHandles.map((handle) => handle.workspaceId));

  const destroyOrphans = input.runnerHandles
    .filter((handle) => !liveIds.has(handle.workspaceId))
    .toSorted((left, right) => left.workspaceId.localeCompare(right.workspaceId));

  const markGone = input.dbLive
    .filter((row) => !runningIds.has(row.id))
    .map((row) => row.id)
    .toSorted((left, right) => left.localeCompare(right));

  return { destroyOrphans, markGone };
}
