/**
 * The `workspace-gc` consumer: reclaim idle workspaces and reconcile what the runner still holds.
 *
 * Layer: service (processor).
 *
 * Containers are cattle. One left running after a chat goes quiet costs memory for nothing, and
 * the chat loses nothing by being rebuilt from history on its next message — which is exactly why
 * the collector is also what keeps the restore path exercised on every long-lived chat.
 *
 * Everything it destroys is selected by the `ah.instance` label. Several checkouts of this project
 * run side by side on one Docker daemon, so a collector that matched anything broader would reap
 * another instance's live workspace.
 */
import {
  destroyChatWorkspacePayload,
  JOB_NAMES,
  planOrphanReconcile,
  selectIdleWorkspaces,
} from '@agent-hangar/core';
import type { Workspace, WorkspaceHandle, WorkspaceStatus } from '@agent-hangar/core';

import { workspaceClaimKey } from '../claims.js';

import { LABELS } from './constants.js';
import { teardownWorkspace } from './teardown-workspace.js';
import type { ProcessorDeps, ProcessorJob } from './types.js';

/** What one collection pass changed. */
export interface GcResult {
  /** Workspaces destroyed because they were idle, or because their chat was archived. */
  reaped: number;
  /** Containers destroyed because no live row pointed at them. */
  orphansDestroyed: number;
  /** Live rows closed out because their container is gone. */
  goneMarked: number;
}

/** `Workspace.failureReason` written for a row whose container no longer exists. */
export const CONTAINER_MISSING_REASON = 'container missing';

/** Nothing collected. */
const NOTHING: GcResult = { reaped: 0, orphansDestroyed: 0, goneMarked: 0 };

/**
 * Live statuses whose row a reconciliation pass may close out when its container is missing.
 *
 * `CREATING` and `BUSY` are left out because something is still running against them and will write
 * their next status itself: a newly provisioned workspace is `CREATING` for as long as it takes its
 * container to appear, and a `BUSY` one has a turn inside it whose stalled recovery owns the case
 * and writes the note that goes with it.
 *
 * Leaving `CREATING` alone puts the burden on the create to keep its promise, and `provisionWorkspace`
 * carries it: a row whose reference could not be written has its container destroyed there, because
 * both sides would otherwise agree on a workspace id and neither sweep here would touch either. The
 * case that remains is a worker that dies between the container being created and that write — no
 * catch runs, and a `CREATING` row keeps a live container that nothing reclaims. Closing it needs a
 * staleness rule for `CREATING` rows, which is a threshold decision rather than a status one: too
 * short and a first-run image pull is reaped mid-create, which is exactly what this exclusion
 * exists to prevent. `STOPPING` is different — the only writer of it is a
 * teardown, teardowns run on this consumer's own single-slot queue and the idle one holds the
 * workspace's claim, so a `STOPPING` row a pass can see is one whose teardown is gone and which
 * nothing else will ever close out.
 */
const RECONCILABLE_STATUSES: readonly WorkspaceStatus[] = ['READY', 'STOPPING'];

/**
 * Destroys the containers this instance owns that no live row points at.
 *
 * @param deps - Runner and logger.
 * @param handles - The orphans the plan selected.
 * @returns How many were destroyed.
 */
async function destroyOrphans(
  deps: ProcessorDeps,
  handles: readonly WorkspaceHandle[],
): Promise<number> {
  let destroyed = 0;
  for (const handle of handles) {
    try {
      await deps.runner.destroy(handle);
      destroyed += 1;
      deps.logger.warn({ workspaceId: handle.workspaceId }, 'orphan workspace destroyed');
    } catch (error) {
      deps.logger.error(
        { err: error, workspaceId: handle.workspaceId },
        'destroying an orphan workspace failed',
      );
    }
  }
  return destroyed;
}

/**
 * Closes out the live rows whose container the runner no longer lists.
 *
 * Which statuses qualify is {@link RECONCILABLE_STATUSES}: a pass that closed out an active
 * creation would mark it `DESTROYED` and leave the create to orphan a container or write over a
 * terminal row. The claim is what makes the state that was read the state at the moment of the
 * write, so a row somebody is working on is left for the next pass rather than closed out from a
 * stale listing.
 *
 * @param deps - Repositories, claims and logger.
 * @param live - The live rows, already read.
 * @param gone - Ids the reconcile plan reported as having no container.
 * @returns How many rows were closed out.
 */
async function closeOutGoneRows(
  deps: ProcessorDeps,
  live: readonly Workspace[],
  gone: ReadonlySet<string>,
): Promise<number> {
  let goneMarked = 0;
  for (const workspace of live.filter(
    (row) => gone.has(row.id) && RECONCILABLE_STATUSES.includes(row.status),
  )) {
    const key = workspaceClaimKey(workspace);
    if (!deps.claims.claim(key)) {
      deps.logger.info(
        { workspaceId: workspace.id },
        'workspace is in use; left for the next pass',
      );
      continue;
    }
    try {
      await deps.repos.workspaces.setStatus(workspace.id, 'DESTROYED', {
        failureReason: CONTAINER_MISSING_REASON,
      });
      goneMarked += 1;
    } finally {
      deps.claims.release(key);
    }
  }
  return goneMarked;
}

/**
 * Destroys containers this instance owns that no live row points at, and closes out the reverse.
 *
 * @param deps - Runner, repositories and logger.
 * @param live - The live rows, already read.
 * @returns How many orphans were destroyed and how many rows were closed out.
 */
async function reconcileOrphans(
  deps: ProcessorDeps,
  live: readonly Workspace[],
): Promise<Pick<GcResult, 'orphansDestroyed' | 'goneMarked'>> {
  const runnerHandles = await deps.runner.list({ [LABELS.instance]: deps.config.AH_INSTANCE });
  const plan = planOrphanReconcile({
    runnerHandles,
    dbLive: live.map((workspace) => ({ id: workspace.id, runnerRef: workspace.runnerRef })),
  });
  const orphansDestroyed = await destroyOrphans(deps, plan.destroyOrphans);
  const goneMarked = await closeOutGoneRows(deps, live, new Set(plan.markGone));
  return { orphansDestroyed, goneMarked };
}

/**
 * Reclaims one workspace the snapshot found idle, if it is still idle and still free.
 *
 * The selection came from a listing taken earlier in the pass, and a turn can claim a `READY`
 * workspace at any point after it. So the teardown asks twice: the claim proves nothing is running
 * in the container right now, and re-reading the row proves it is still an idle `READY` one rather
 * than a workspace a turn has just used and released.
 *
 * @param deps - Runner, repositories, claims, clock and logger.
 * @param candidate - The workspace the snapshot selected.
 * @param idleTtlMin - Configured idle TTL, in minutes.
 * @returns Whether its container is gone.
 */
async function reclaimIdle(
  deps: ProcessorDeps,
  candidate: Workspace,
  idleTtlMin: number,
): Promise<boolean> {
  const key = workspaceClaimKey(candidate);
  if (!deps.claims.claim(key)) {
    deps.logger.info({ workspaceId: candidate.id }, 'workspace is in use; left for the next pass');
    return false;
  }
  try {
    const current = await deps.repos.workspaces.get(candidate.id);
    if (
      current === null ||
      selectIdleWorkspaces([current], { now: deps.clock.now(), idleTtlMin }).length === 0
    ) {
      deps.logger.info({ workspaceId: candidate.id }, 'workspace is no longer idle; left alone');
      return false;
    }
    const outcome = await teardownWorkspace(deps, current, {
      reason: 'idle',
      idleMinutes: idleTtlMin,
    });
    return outcome === 'destroyed';
  } finally {
    deps.claims.release(key);
  }
}

/**
 * Reclaims idle workspaces, then reconciles containers against rows.
 *
 * @param deps - Runner, repositories, clock and logger.
 * @returns What the pass changed.
 */
async function reapIdle(deps: ProcessorDeps): Promise<GcResult> {
  const live = await deps.repos.workspaces.listLive();
  const idleTtlMin = deps.config.WORKSPACE_IDLE_TTL_MIN;
  const idle = new Set(selectIdleWorkspaces(live, { now: deps.clock.now(), idleTtlMin }));

  let reaped = 0;
  for (const workspace of live.filter((candidate) => idle.has(candidate.id))) {
    if (await reclaimIdle(deps, workspace, idleTtlMin)) {
      reaped += 1;
    }
  }

  const remaining = await deps.repos.workspaces.listLive();
  const result: GcResult = { reaped, ...(await reconcileOrphans(deps, remaining)) };
  deps.logger.info(result, 'workspace collection finished');
  return result;
}

/**
 * Destroys the live workspace of a chat that was archived.
 *
 * The archive runs on its own queue, so it can arrive while a turn of the chat is executing. It
 * takes the same claim that turn holds rather than tearing the container down underneath it: a
 * container removed mid-exec fails a turn the user is watching, and the archive loses nothing by
 * waiting — the chat takes no further turn, so the workspace falls idle and the collector reaps it
 * on a later pass.
 *
 * @param deps - Runner, repositories, claims and logger.
 * @param chatId - The archived chat.
 * @returns What the pass changed.
 */
async function destroyChatWorkspace(deps: ProcessorDeps, chatId: string): Promise<GcResult> {
  const workspace = await deps.repos.workspaces.findLiveByChat(chatId);
  if (workspace !== null) {
    const key = workspaceClaimKey(workspace);
    if (!deps.claims.claim(key)) {
      deps.logger.info({ chatId }, 'workspace is in use; left for the idle collector');
      return NOTHING;
    }
    try {
      const outcome = await teardownWorkspace(deps, workspace, { reason: 'archive' });
      return { ...NOTHING, reaped: outcome === 'destroyed' ? 1 : 0 };
    } finally {
      deps.claims.release(key);
    }
  }
  // Deleting a chat enqueues this teardown and then cascades the rows away, which clears the
  // workspace's chat reference — so by the time this runs there may be no row to look up and the
  // container is only reachable by the label it was created with.
  const orphaned = await deps.runner.list({
    [LABELS.instance]: deps.config.AH_INSTANCE,
    [LABELS.chat]: chatId,
  });
  if (orphaned.length === 0) {
    deps.logger.info({ chatId }, 'chat had no live workspace');
    return NOTHING;
  }
  let orphansDestroyed = 0;
  for (const handle of orphaned) {
    try {
      await deps.runner.destroy(handle);
      orphansDestroyed += 1;
      deps.logger.warn({ chatId, workspaceId: handle.workspaceId }, 'orphan workspace destroyed');
    } catch (error) {
      deps.logger.error(
        { err: error, workspaceId: handle.workspaceId },
        'destroying an orphan workspace failed',
      );
    }
  }
  return { ...NOTHING, orphansDestroyed };
}

/**
 * Builds the `workspace-gc` consumer.
 *
 * @param deps - The processor's collaborators.
 * @returns A BullMQ processor for the `workspace-gc` queue, dispatching on the job name.
 */
export function createGcProcessor(
  deps: ProcessorDeps,
): (job: ProcessorJob<unknown>) => Promise<GcResult> {
  return async (job: ProcessorJob<unknown>): Promise<GcResult> => {
    if (job.name === JOB_NAMES.reapIdle) {
      return reapIdle(deps);
    }
    if (job.name === JOB_NAMES.destroyChatWorkspace) {
      const { chatId } = destroyChatWorkspacePayload.parse(job.data);
      return destroyChatWorkspace(deps, chatId);
    }
    deps.logger.warn({ name: job.name }, 'unknown workspace-gc job');
    return Promise.resolve(NOTHING);
  };
}
