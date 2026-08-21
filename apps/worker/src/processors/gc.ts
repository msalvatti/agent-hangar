/**
 * The `workspace-gc` consumer: reclaim idle workspaces and reconcile what the runner still holds.
 *
 * Layer: service (processor).
 *
 * Containers are cattle. One left running after a chat goes quiet costs memory for nothing, and
 * the chat loses nothing by being rebuilt from history on its next message — which is exactly why
 * the collector is also what keeps the restore path exercised on every long-lived chat.
 *
 * The same sentence is why the pass reconciles in three directions rather than one: a container no
 * row points at, a row no container answers for, and a row whose owner committed to destroying its
 * container and then never did. All three cost the same memory, and none of them is reported by
 * anything the user can see.
 *
 * Everything it destroys is selected by the `ah.instance` label. Several checkouts of this project
 * run side by side on one Docker daemon, so a collector that matched anything broader would reap
 * another instance's live workspace.
 */
import {
  destroyChatWorkspacePayload,
  isLiveWorkspaceStatus,
  JOB_NAMES,
  planOrphanReconcile,
  selectIdleWorkspaces,
} from '@agent-hangar/core';
import type {
  DestroyChatWorkspacePayload,
  Workspace,
  WorkspaceHandle,
  WorkspaceStatus,
} from '@agent-hangar/core';

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
  /** Containers destroyed on behalf of a teardown that never came back for them. */
  teardownsFinished: number;
}

/** `Workspace.failureReason` written for a row whose container no longer exists. */
export const CONTAINER_MISSING_REASON = 'container missing';

/** `Workspace.failureReason` written for a row whose teardown never came back. */
export const ABANDONED_TEARDOWN_REASON = 'teardown abandoned';

/** Nothing collected. */
const NOTHING: GcResult = {
  reaped: 0,
  orphansDestroyed: 0,
  goneMarked: 0,
  teardownsFinished: 0,
};

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
 * Reports why a live workspace can only be one a previous incarnation of this worker left behind.
 *
 * `STOPPING` is the only status that qualifies, and what qualifies it is not that a booting process
 * holds no teardown — it is what the row's owner has already committed to. A teardown reaches
 * `STOPPING` only after deciding to destroy the container, and writes `DESTROYED` or `FAILED` next.
 * So even where the "one worker per instance" assumption fails and a live sibling owns the row, both
 * writers want the same thing, and the worst outcome is a row reading `FAILED` instead of
 * `DESTROYED` and a container the orphan pass removes.
 *
 * `BUSY` does not qualify, and the difference is the whole point: a `BUSY` row's owner has committed
 * to the opposite — it is executing inside that container. A second worker booting cannot see the
 * sibling's process-local claim, so closing the row out would hand its container to the orphan pass
 * with a live exec still in it. That is the cross-process race these conditional writes exist to
 * remove, so this pass may not be the thing that reintroduces it. A `JOB` workspace left `BUSY` is
 * reclaimed instead by the stalled-run recovery, which finds it through the `workspaceId` its run
 * records before taking it; a `CHAT` one by `recoverStalledWorkspace`, which also writes the SYSTEM
 * note telling the model its filesystem is gone.
 *
 * @param workspace - A live row.
 * @returns What to record as its `failureReason`, or `null` when the row may still have an owner.
 */
function abandonedReason(workspace: Workspace): string | null {
  return workspace.status === 'STOPPING' ? ABANDONED_TEARDOWN_REASON : null;
}

/**
 * Closes out the live rows a previous incarnation of this worker left behind.
 *
 * Every conditional write in the worker moves a row into a status whose owner is the process that
 * wrote it, so each one needs an answer to "what reclaims this if the process dies immediately
 * after?". Three of them answer for themselves: a write whose target is `DESTROYED` is terminal, and
 * its container becomes an orphan that {@link reconcileOrphans} removes. A turn taking a chat
 * workspace `BUSY` is answered by `recoverStalledWorkspace`, which finds the row through the chat
 * rather than through the turn. The two that have no such handle are answered here: a teardown's
 * `STOPPING`, and a scheduled run's `BUSY`, whose only link to its run is an id the run had not yet
 * written when it died.
 *
 * What makes this recoverable without a threshold is *when* it runs. Age cannot tell a process that
 * died from one that is merely slow — the two rows are identical — but at boot the question does not
 * arise: this process holds neither, and an instance runs one worker, so a row in one of those
 * statuses belongs to an incarnation that is gone. This is the same point `createShutdown` already
 * names when it says an abandoned job leaves a container the next boot has to reconcile.
 *
 * It closes the row out and stops. Destroying the container is left to {@link reconcileOrphans},
 * which is what that pass is for and which will find it the moment the row stops being live. So this
 * needs the database and nothing else — which only helps if nothing ahead of it needs more, and a
 * daemon that is down is the likeliest reason a worker died holding these rows. `prepareBoot` is
 * where that ordering is kept, and where it is asserted.
 *
 * This is no longer the only thing that reclaims such a row: {@link finishAbandonedTeardowns} does
 * it in the steady state, for the case a boot cannot help with at all — a teardown that abandoned
 * its row while its process kept running. The two are not redundant. Boot is the cheaper answer
 * where it applies, because it needs no daemon and can close out a row while Docker is down, which
 * is the likeliest reason the last incarnation died.
 *
 * @param deps - Repositories, claims and logger.
 * @returns How many rows were closed out.
 */
export async function recoverAbandonedWorkspaces(deps: ProcessorDeps): Promise<number> {
  const live = await deps.repos.workspaces.listLive();
  let recovered = 0;
  for (const workspace of live) {
    const failureReason = abandonedReason(workspace);
    if (failureReason === null) {
      continue;
    }
    const key = workspaceClaimKey(workspace);
    if (!deps.claims.claim(key)) {
      // Unreachable from the boot call, where nothing has started yet; the guard is what lets work
      // of this process be in flight without this ever being the thing that took its row.
      deps.logger.info(
        { workspaceId: workspace.id },
        'work is still in flight; its workspace is left alone',
      );
      continue;
    }
    try {
      const closed = await deps.repos.workspaces.claimStatus(
        workspace.id,
        workspace.status,
        'DESTROYED',
        { failureReason },
      );
      if (closed === null) {
        continue;
      }
      recovered += 1;
      deps.logger.warn(
        { workspaceId: workspace.id, failureReason },
        'workspace closed out: the work holding it never came back',
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
 * Finishes the teardowns whose process never came back for the container.
 *
 * This is the case the two passes above cannot reach between them. A row is `STOPPING` and its
 * container is still listed, so it is neither an orphan — a live row points at it — nor a row whose
 * container is gone. Nothing else can take it either: a teardown refuses anything that is not
 * `READY`, and so does the idle selection. Until this existed, the only thing that reclaimed such a
 * row was the next worker boot, so a teardown that lost its process left a container holding its
 * memory ceiling for as long as the worker kept running.
 *
 * It is safe for the same reason `STOPPING` is safe to name in {@link RECONCILABLE_STATUSES}, and
 * that reason is about what the row's owner has committed to rather than about how old the row is.
 * A teardown reaches `STOPPING` only after deciding to destroy the container, and writes
 * `DESTROYED` or `FAILED` next. So finishing the job on its behalf is the thing it was going to do:
 * where the owner is really gone this is the whole repair, and in the case this project keeps
 * arguing about — a second worker on one instance — both writers want the same terminal state and
 * `destroy` is idempotent. What must never be done to a row whose owner is *executing* inside the
 * container is done to none of them: `BUSY` is not named here, and could not be, because its owner
 * has committed to the opposite. Any status added here needs a safety argument of its own.
 *
 * Age is not consulted, which is what keeps this out of the trap the port-base allocator fell into.
 * The in-process claim is what stands in for it: every teardown holds its workspace's claim across
 * the whole sequence, so a claim that can be taken here is a row no teardown of this process is
 * running. That is a fact rather than an estimate, and it is the reason this may run in the steady
 * state where an age threshold may not.
 *
 * @param deps - Runner, repositories, claims, redactor and logger.
 * @param live - The live rows, already read.
 * @param gone - Ids the reconcile plan reported as having no container; those are already closed
 *   out by {@link closeOutGoneRows} and have nothing left to destroy.
 * @returns How many containers were destroyed on an abandoned teardown's behalf.
 */
async function finishAbandonedTeardowns(
  deps: ProcessorDeps,
  live: readonly Workspace[],
  gone: ReadonlySet<string>,
): Promise<number> {
  let finished = 0;
  for (const workspace of live.filter((row) => row.status === 'STOPPING' && !gone.has(row.id))) {
    const key = workspaceClaimKey(workspace);
    if (!deps.claims.claim(key)) {
      deps.logger.info(
        { workspaceId: workspace.id },
        'a teardown is still running; its workspace is left for the next pass',
      );
      continue;
    }
    try {
      finished += (await destroyForAbandonedTeardown(deps, workspace)) ? 1 : 0;
    } finally {
      deps.claims.release(key);
    }
  }
  return finished;
}

/**
 * Destroys one abandoned teardown's container and writes the terminal status it never wrote.
 *
 * The status is claimed rather than set, so a teardown that came back after all — the cross-process
 * case — leaves the row exactly once, whichever of the two writers the database lets through. Both
 * are writing a terminal status, so the row reads the same either way.
 *
 * @param deps - Runner, repositories, redactor and logger.
 * @param workspace - The `STOPPING` row whose container is still there.
 * @returns `true` when the container is gone.
 */
async function destroyForAbandonedTeardown(
  deps: ProcessorDeps,
  workspace: Workspace,
): Promise<boolean> {
  try {
    await deps.runner.destroy({
      workspaceId: workspace.id,
      runnerRef: workspace.runnerRef ?? '',
    });
  } catch (error) {
    const failureReason = deps.redactor.redact(
      error instanceof Error ? error.message : String(error),
    );
    await deps.repos.workspaces.claimStatus(workspace.id, 'STOPPING', 'FAILED', { failureReason });
    deps.logger.error(
      { err: error, workspaceId: workspace.id },
      'finishing an abandoned teardown failed',
    );
    return false;
  }
  await deps.repos.workspaces.claimStatus(workspace.id, 'STOPPING', 'DESTROYED', {
    failureReason: ABANDONED_TEARDOWN_REASON,
  });
  deps.logger.warn(
    { workspaceId: workspace.id },
    'finished a teardown whose process never came back for the container',
  );
  return true;
}

/**
 * Destroys containers this instance owns that no live row points at, and closes out the reverse.
 *
 * @param deps - Runner, repositories and logger.
 * @param live - The live rows, already read.
 * @returns How many orphans were destroyed, how many rows were closed out, and how many teardowns
 *   were finished on an absent owner's behalf.
 */
async function reconcileOrphans(
  deps: ProcessorDeps,
  live: readonly Workspace[],
): Promise<Pick<GcResult, 'orphansDestroyed' | 'goneMarked' | 'teardownsFinished'>> {
  const runnerHandles = await deps.runner.list({ [LABELS.instance]: deps.config.AH_INSTANCE });
  const plan = planOrphanReconcile({
    runnerHandles,
    dbLive: live.map((workspace) => ({ id: workspace.id, runnerRef: workspace.runnerRef })),
  });
  const gone = new Set(plan.markGone);
  const orphansDestroyed = await destroyOrphans(deps, plan.destroyOrphans);
  const goneMarked = await closeOutGoneRows(deps, live, gone);
  const teardownsFinished = await finishAbandonedTeardowns(deps, live, gone);
  return { orphansDestroyed, goneMarked, teardownsFinished };
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
 * Finds the live workspace a `destroy-chat-workspace` delivery is about.
 *
 * @param deps - Repositories.
 * @param payload - The chat, and the workspace when the producer named one.
 * @returns The workspace to tear down, or `null` when there is no live row to act on.
 */
async function findWorkspaceToDestroy(
  deps: ProcessorDeps,
  payload: DestroyChatWorkspacePayload,
): Promise<Workspace | null> {
  if (payload.workspaceId === undefined) {
    return deps.repos.workspaces.findLiveByChat(payload.chatId);
  }
  const workspace = await deps.repos.workspaces.get(payload.workspaceId);
  return workspace !== null && isLiveWorkspaceStatus(workspace.status) ? workspace : null;
}

/**
 * Destroys the live workspace of a chat that was archived or deleted.
 *
 * The row is addressed by the id the delivery carries, and falls back to the chat only when the
 * delivery carries none. That order is the whole point: a *delete* clears `Workspace.chatId` in the
 * step before this job runs, because the column is `SetNull` on the chat's cascade — so a lookup by
 * chat finds nothing for exactly the deliveries that most need to find something. What that used to
 * leave behind was measured: the container was destroyed by the label sweep below, which writes no
 * row, and the workspace stayed `READY` with a reference to a container that no longer existed —
 * a row claiming to be live with nothing to claim, reclaimed only by a later collection pass that
 * recorded it as a missing container rather than as the teardown it was.
 *
 * This job runs on its own queue, so it can arrive while a turn of the chat is executing. Unlike
 * the idle pass, which selects only `READY` rows, this one hands the teardown whatever live
 * workspace it found — so the teardown's own rule that only a `READY` workspace may be taken is
 * what protects the running turn, and the claim taken here only saves this worker the work. A
 * container removed mid-exec fails a turn the user is watching, and the archive loses nothing by
 * waiting: the chat takes no further turn, so the workspace falls idle and the collector reaps it
 * on a later pass. The same holds for the two live statuses nobody can hand over either: a
 * workspace still being created finishes and then falls idle, and one left `STOPPING` by a
 * teardown that died is finished by the reconciliation above, which destroys the container its
 * owner had already committed to destroying. Neither is forced here, because forcing it is what
 * would destroy a filesystem somebody is using.
 *
 * @param deps - Runner, repositories, claims and logger.
 * @param payload - The chat, and the workspace when the producer named one.
 * @returns What the pass changed.
 */
async function destroyChatWorkspace(
  deps: ProcessorDeps,
  payload: DestroyChatWorkspacePayload,
): Promise<GcResult> {
  const { chatId } = payload;
  const workspace = await findWorkspaceToDestroy(deps, payload);
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
      return destroyChatWorkspace(deps, destroyChatWorkspacePayload.parse(job.data));
    }
    deps.logger.warn({ name: job.name }, 'unknown workspace-gc job');
    return Promise.resolve(NOTHING);
  };
}
