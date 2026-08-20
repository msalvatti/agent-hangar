/**
 * Destroying one workspace and keeping what the chat needs to be rebuilt from history.
 *
 * Layer: service.
 *
 * The order is what matters: snapshot first, then the hints, then the note, then the container.
 * Destroying before reading would throw away the only record of where the agent's work ended up,
 * and the chat would come back on the base branch with the pushed commits invisible.
 *
 * Nothing here throws. The collector tears down many workspaces in one pass, and one container the
 * daemon refuses to remove must not stop the rest — that one is recorded as `FAILED` and left for
 * the next reconciliation.
 */
import { archivedNotice } from '@agent-hangar/core';
import type { Workspace, WorkspaceSnapshot } from '@agent-hangar/core';

import type { ProcessorDeps } from './types.js';

/** Why a workspace is being destroyed. */
export type TeardownReason = 'idle' | 'archive';

/** What a teardown produced. */
export type TeardownOutcome = 'destroyed' | 'failed';

/** Options of {@link teardownWorkspace}. */
export interface TeardownOptions {
  reason: TeardownReason;
  /** How long the workspace had been idle; named in the note when the reason is `idle`. */
  idleMinutes?: number;
}

/**
 * A `git status --porcelain` entry: exactly two status characters and a space.
 *
 * The diff stat that follows in the same summary cannot match it — its lines begin with a file
 * name, so the third character is never a space — which is what lets one regular expression read
 * a summary that carries both.
 */
const PORCELAIN_ENTRY = /^[ MADRCU?!]{2} \S/;

/**
 * Counts the uncommitted entries a snapshot reported.
 *
 * @param snapshot - The snapshot taken before the container was destroyed.
 * @returns How many paths `git status --porcelain` listed.
 */
export function countDirtyEntries(snapshot: WorkspaceSnapshot): number {
  return snapshot.summary.split('\n').filter((line) => PORCELAIN_ENTRY.test(line)).length;
}

/**
 * Builds the SYSTEM message that tells the model what happened to its filesystem.
 *
 * The wording is normative (spec 02 §4): a restored chat is indistinguishable from a continued one
 * from the model's point of view, and this note is the only thing that keeps it honest.
 *
 * @param options - Why the workspace went away, and for how long it had been idle.
 * @param discarded - How many uncommitted entries were lost.
 * @returns The message text.
 */
export function formatTeardownNote(options: TeardownOptions, discarded: number): string {
  if (options.reason === 'archive') {
    return archivedNotice({ uncommittedChanges: discarded });
  }
  const minutes = options.idleMinutes ?? 0;
  const changes =
    discarded === 0
      ? 'no uncommitted changes'
      : `${discarded} uncommitted ${discarded === 1 ? 'change' : 'changes'} discarded`;
  return `Workspace reclaimed after ${minutes} min idle; ${changes}. It will be recreated from history on the next message.`;
}

/**
 * Reads the workspace's git state, tolerating a container that can no longer answer.
 *
 * @param deps - Runner and logger.
 * @param workspace - The workspace being torn down.
 * @returns The snapshot, or `null` when it could not be taken.
 */
async function snapshotOrNull(
  deps: ProcessorDeps,
  workspace: Workspace,
): Promise<WorkspaceSnapshot | null> {
  try {
    return await deps.runner.snapshot({
      workspaceId: workspace.id,
      runnerRef: workspace.runnerRef ?? '',
    });
  } catch (error) {
    deps.logger.warn(
      { err: error, workspaceId: workspace.id },
      'could not snapshot a workspace before destroying it',
    );
    return null;
  }
}

/**
 * Writes the restore hints and the note a chat needs before its workspace disappears.
 *
 * Hints are written only when the snapshot found nothing unpushed: pointing a later turn at a
 * branch whose commits never left the container would make it check out work that does not exist.
 *
 * @param deps - Repositories.
 * @param chatId - The chat the workspace served.
 * @param snapshot - What the container reported, or `null`.
 * @param options - Why the workspace is going away.
 */
async function recordForChat(
  deps: ProcessorDeps,
  chatId: string,
  snapshot: WorkspaceSnapshot | null,
  options: TeardownOptions,
): Promise<void> {
  if (snapshot !== null && snapshot.git.ahead === 0 && snapshot.git.branch !== null) {
    await deps.repos.chats.updateRestoreHints(chatId, {
      workBranch: snapshot.git.branch,
      lastPushedSha: snapshot.git.headSha,
    });
  }
  const discarded = snapshot === null ? 0 : countDirtyEntries(snapshot);
  await deps.repos.messages.append(chatId, 'SYSTEM', formatTeardownNote(options, discarded));
}

/**
 * Destroys a workspace, keeping what its chat needs to come back.
 *
 * @param deps - Runner, repositories and logger.
 * @param workspace - The workspace to destroy.
 * @param options - Why it is going away.
 * @returns Whether the container is gone.
 */
export async function teardownWorkspace(
  deps: ProcessorDeps,
  workspace: Workspace,
  options: TeardownOptions,
): Promise<TeardownOutcome> {
  await deps.repos.workspaces.setStatus(workspace.id, 'STOPPING');
  const snapshot = await snapshotOrNull(deps, workspace);
  if (workspace.kind === 'CHAT' && workspace.chatId !== null) {
    await recordForChat(deps, workspace.chatId, snapshot, options);
  }
  try {
    await deps.runner.destroy({
      workspaceId: workspace.id,
      runnerRef: workspace.runnerRef ?? '',
    });
  } catch (error) {
    const failureReason = deps.redactor.redact(
      error instanceof Error ? error.message : String(error),
    );
    await deps.repos.workspaces.setStatus(workspace.id, 'FAILED', { failureReason });
    deps.logger.error({ err: error, workspaceId: workspace.id }, 'destroying a workspace failed');
    return 'failed';
  }
  await deps.repos.workspaces.setStatus(workspace.id, 'DESTROYED');
  return 'destroyed';
}
