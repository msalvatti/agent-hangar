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
import type { Workspace } from '@agent-hangar/core';

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
 * Destroys containers this instance owns that no live row points at.
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

  let orphansDestroyed = 0;
  for (const handle of plan.destroyOrphans) {
    try {
      await deps.runner.destroy(handle);
      orphansDestroyed += 1;
      deps.logger.warn({ workspaceId: handle.workspaceId }, 'orphan workspace destroyed');
    } catch (error) {
      deps.logger.error(
        { err: error, workspaceId: handle.workspaceId },
        'destroying an orphan workspace failed',
      );
    }
  }

  const gone = new Set(plan.markGone);
  // A `BUSY` row is left alone: a turn is running against it, and the reason its container is not
  // listed may simply be that this pass raced the create. The turn processor's stalled recovery
  // owns that case, and it has the context to write the SYSTEM note that goes with it.
  const closable = live.filter(
    (workspace) => gone.has(workspace.id) && workspace.status !== 'BUSY',
  );
  for (const workspace of closable) {
    await deps.repos.workspaces.setStatus(workspace.id, 'DESTROYED', {
      failureReason: CONTAINER_MISSING_REASON,
    });
  }
  return { orphansDestroyed, goneMarked: closable.length };
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
    const outcome = await teardownWorkspace(deps, workspace, {
      reason: 'idle',
      idleMinutes: idleTtlMin,
    });
    if (outcome === 'destroyed') {
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
 * @param deps - Runner, repositories and logger.
 * @param chatId - The archived chat.
 * @returns What the pass changed.
 */
async function destroyChatWorkspace(deps: ProcessorDeps, chatId: string): Promise<GcResult> {
  const workspace = await deps.repos.workspaces.findLiveByChat(chatId);
  if (workspace === null) {
    deps.logger.info({ chatId }, 'archived chat had no live workspace');
    return NOTHING;
  }
  const outcome = await teardownWorkspace(deps, workspace, { reason: 'archive' });
  return { ...NOTHING, reaped: outcome === 'destroyed' ? 1 : 0 };
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
