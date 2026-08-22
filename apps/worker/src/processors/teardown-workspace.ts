/**
 * Destroying one workspace and keeping what the chat needs to be rebuilt from history.
 *
 * Layer: service.
 *
 * The order is what matters: snapshot first, then the hints, then the note, then `STOPPING`, then
 * the container. Destroying before reading would throw away the only record of where the agent's
 * work ended up, and the chat would come back on the base branch with the pushed commits
 * invisible. `STOPPING` is written last of the row updates because the lifecycle lets it lead only
 * to `DESTROYED` or `FAILED`: a row parked there by bookkeeping that failed could never be walked
 * back, and the collector — which reclaims `READY` rows and reconciles only rows whose container
 * has gone — would leave that workspace and its live container alone forever. Everything before
 * the destroy therefore happens while the row still says what it did before, so a pass that fails
 * there changes nothing and the next pass starts over.
 *
 * A failure is reported, not thrown. The collector tears down many workspaces in one pass, and one
 * container the daemon refuses to remove — or one chat record the database refuses to write — must
 * not stop the rest.
 *
 * A teardown may only take a workspace that is `READY`, and it asks in two steps. The row it was
 * handed is checked first, because the other live statuses are not races to lose but rows with an
 * owner: `CREATING` belongs to whoever is provisioning, `BUSY` to the turn executing inside the
 * container, `STOPPING` to another teardown. Tearing one of those down destroys a filesystem
 * somebody is using, and naming the status found instead of `READY` would make that an *accepted*
 * claim — `BUSY -> STOPPING` is a valid move, and `STOPPING -> STOPPING` would let two teardowns
 * both believe they won.
 *
 * The `READY -> STOPPING` write is the second step and the binding one. Everything between the two
 * takes time — an exec into the container, two writes for the chat — and a turn may take the
 * workspace while it runs, so the write that commits to destroying the container is also the one
 * that arbitrates, whichever process the other writer is in.
 *
 * What that write cannot take back is the note already appended to the chat, so a teardown that
 * loses at that point leaves a message saying the workspace was reclaimed when it was not. It is
 * the only way left to lose — a row that was owned when it was read is refused before anything is
 * recorded — and within one worker it cannot happen at all, because the collector holds the
 * workspace's claim across the whole sequence. Across workers a stale sentence in the transcript
 * is the cheaper of the two outcomes: writing the record after the destroy would lose it
 * altogether whenever the process dies in between.
 */
import { archivedNotice, describeClientFailure } from '@agent-hangar/core';
import type { Workspace, WorkspaceSnapshot } from '@agent-hangar/core';

import type { ProcessorDeps } from './types.js';

/** Why a workspace is being destroyed. */
export type TeardownReason = 'idle' | 'archive';

/** What a teardown produced. */
export type TeardownOutcome = 'destroyed' | 'failed' | 'skipped';

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
 * Reads the workspace and writes what its chat needs, before anything is torn down.
 *
 * @param deps - Runner, repositories and logger.
 * @param workspace - The workspace being torn down.
 * @param options - Why it is going away.
 * @returns `true` when the teardown may go on to destroy the container; `false` when the record
 *   could not be written, in which case nothing has changed and a later pass can start over.
 */
async function recordBeforeTeardown(
  deps: ProcessorDeps,
  workspace: Workspace,
  options: TeardownOptions,
): Promise<boolean> {
  const snapshot = await snapshotOrNull(deps, workspace);
  // Whether there is a chat to write for, which is not the same question as what kind of workspace
  // this is: a scheduled run's workspace never had one, and a chat's workspace loses the reference
  // when the chat is deleted. Either way there is nobody to hand a branch or a note to.
  if (workspace.chatId === null) {
    return true;
  }
  try {
    await recordForChat(deps, workspace.chatId, snapshot, options);
    return true;
  } catch (error) {
    // The repository's error is described rather than logged: a driver builds its message from
    // the connection string it was configured with, password included.
    deps.logger.error(
      { failure: describeClientFailure(error), workspaceId: workspace.id },
      'recording what a chat needs before its workspace is destroyed failed',
    );
    return false;
  }
}

/**
 * Destroys a workspace, keeping what its chat needs to come back.
 *
 * @param deps - Runner, repositories and logger.
 * @param workspace - The workspace to destroy.
 * @param options - Why it is going away.
 * @returns `destroyed` when the container is gone, `failed` when it could not be, and `skipped`
 *   when the workspace was not this teardown's to take — owned by another writer when it was read,
 *   or taken by one before the `STOPPING` claim landed.
 */
export async function teardownWorkspace(
  deps: ProcessorDeps,
  workspace: Workspace,
  options: TeardownOptions,
): Promise<TeardownOutcome> {
  if (workspace.status !== 'READY') {
    deps.logger.info(
      { workspaceId: workspace.id, foundStatus: workspace.status },
      'workspace is not free to stop; left for a later pass',
    );
    return 'skipped';
  }
  if (!(await recordBeforeTeardown(deps, workspace, options))) {
    return 'failed';
  }
  // The row was read before the snapshot was taken and before the chat's record was written, and
  // a turn can take the workspace in that window. `READY` is what makes this a claim rather than
  // an overwrite: the container that turn is executing in is left alone, and the workspace falls
  // idle again for a later pass.
  const stopping = await deps.repos.workspaces.claimStatus(workspace.id, 'READY', 'STOPPING');
  if (stopping === null) {
    deps.logger.info(
      { workspaceId: workspace.id },
      'workspace was taken while its record was written; left for a later pass',
    );
    return 'skipped';
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
