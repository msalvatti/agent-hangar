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

/** `Workspace.failureReason` written for a row whose teardown never came back. */
export const ABANDONED_TEARDOWN_REASON = 'teardown abandoned';

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
 * exists to prevent. `STOPPING` is different, and for a reason that survives a second worker
 * process: the only writer of it is a teardown, a teardown reaches `STOPPING` only after it has
 * committed to destroying the container, and the only statuses it writes after that are
 * `DESTROYED` and `FAILED`. So the two writers of a `STOPPING` row whose container is already gone
 * — this pass and the teardown that removed it — agree on the terminal state, and whichever of
 * them the conditional write lets through leaves the same row. That is what makes `STOPPING` safe
 * to name here while it is not safe to name in a teardown's own claim, where the move would be
 * `STOPPING -> STOPPING` and both callers would proceed to destroy.
 */
const RECONCILABLE_STATUSES: readonly WorkspaceStatus[] = ['READY', 'STOPPING'];

/**
 * Closes out the `STOPPING` rows a previous incarnation of this worker left behind.
 *
 * A teardown writes `STOPPING` and then destroys the container. A process that dies in between —
 * a crash, or the forced shutdown that abandons jobs past the grace period — leaves a row nothing
 * else in the system will ever reclaim: a teardown refuses it because only a `READY` workspace is
 * free to take, the idle selection refuses it for the same reason, and the reconciliation refuses
 * it because its container is still running, so it is not gone. The row stays live and the
 * container stays up, silently, forever.
 *
 * What makes this recoverable without a threshold is *when* it runs. Age cannot tell a teardown
 * that died from one that is merely slow — the two rows are identical — but at boot the question
 * does not arise: this process holds no teardowns, and an instance runs one worker, so a
 * `STOPPING` row that exists here belongs to an incarnation that is gone. This is the same point
 * `createShutdown` already names when it says an abandoned job leaves a container the next boot
 * has to reconcile.
 *
 * It closes the row out and stops. Destroying the container is left to {@link reconcileOrphans},
 * which is what that pass is for and which will find it the moment the row stops being live —
 * so the recovery needs no Docker connection, and still works on a boot where the daemon is down.
 *
 * @param deps - Repositories, claims and logger.
 * @returns How many rows were closed out.
 */
export async function recoverAbandonedTeardowns(deps: ProcessorDeps): Promise<number> {
  const live = await deps.repos.workspaces.listLive();
  let recovered = 0;
  for (const workspace of live.filter((row) => row.status === 'STOPPING')) {
    const key = workspaceClaimKey(workspace);
    if (!deps.claims.claim(key)) {
      // Unreachable from the boot call, where nothing has started yet; the guard is what lets a
      // teardown of this process be in flight without this ever being the thing that took its row.
      deps.logger.info(
        { workspaceId: workspace.id },
        'teardown is still in flight; its workspace is left alone',
      );
      continue;
    }
    try {
      const closed = await deps.repos.workspaces.claimStatus(
        workspace.id,
        'STOPPING',
        'DESTROYED',
        {
          failureReason: ABANDONED_TEARDOWN_REASON,
        },
      );
      if (closed === null) {
        continue;
      }
      recovered += 1;
      deps.logger.warn(
        { workspaceId: workspace.id },
        'workspace closed out: its teardown never came back',
      );
    } finally {
      deps.claims.release(key);
    }
  }
  return recovered;
}

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
 * terminal row. The conditional write is what makes the state that was read the state at the
 * moment of the write, so a row somebody is working on is left for the next pass rather than
 * closed out from a stale listing.
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
      // The listing this row came from was taken before the runner was asked what it still holds,
      // so a turn may have taken the workspace since. Closing it out unconditionally would write
      // `DESTROYED` over a workspace that is executing; naming the status the listing reported
      // leaves that one alone and closes out only the row that has not moved. Naming the status
      // found is safe here and nowhere else in this file: the target is terminal, so a second
      // caller can never match the row this one wrote, and both statuses that reach here are
      // rows whose only other writer would reach the same terminal state (see
      // {@link RECONCILABLE_STATUSES}).
      const closed = await deps.repos.workspaces.claimStatus(
        workspace.id,
        workspace.status,
        'DESTROYED',
        { failureReason: CONTAINER_MISSING_REASON },
      );
      if (closed === null) {
        deps.logger.info(
          { workspaceId: workspace.id, expectedStatus: workspace.status },
          'workspace moved on since the listing; left for the next pass',
        );
      } else {
        goneMarked += 1;
      }
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
 * The selection came from a listing taken earlier in the pass, and a turn can take a `READY`
 * workspace at any point after it. So the teardown asks three times, and only the last answer is
 * binding: the in-process claim skips work another consumer of this process is already doing,
 * re-reading the row proves it is still an idle `READY` one rather than a workspace a turn has
 * just used and released, and the conditional `STOPPING` write inside the teardown is what
 * actually decides — it applies only while the row still holds what was read, whichever process
 * the other writer is in.
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
 * The archive runs on its own queue, so it can arrive while a turn of the chat is executing. Unlike
 * the idle pass, which selects only `READY` rows, this one hands the teardown whatever live
 * workspace the chat has — so the teardown's own rule that only a `READY` workspace may be taken is
 * what protects the running turn, and the claim taken here only saves this worker the work. A
 * container removed mid-exec fails a turn the user is watching, and the archive loses nothing by
 * waiting: the chat takes no further turn, so the workspace falls idle and the collector reaps it
 * on a later pass. The same holds for the two live statuses nobody can hand over either: a
 * workspace still being created finishes and then falls idle, and one left `STOPPING` by a
 * teardown that died is reclaimed by the reconciliation above once its container is gone. Neither
 * is forced here, because forcing it is what would destroy a filesystem somebody is using.
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
