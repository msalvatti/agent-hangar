/**
 * The "ensure workspace" decision the worker takes before every turn.
 *
 * Layer: domain (pure).
 *
 * Restoring an archived chat is deliberately not a separate code path: the worker always asks
 * "is there a live workspace for this chat?" and, when there is not, creates one and clones from
 * the persisted context. An archived chat, a workspace reaped by the idle collector and a worker
 * that crashed mid-turn therefore all take the same branch, which is why restore is exercised on
 * every long-lived chat rather than only on archived ones.
 */
import { WorkspaceImageMissing } from '../errors.js';

import { WorkspaceBusyError } from './errors.js';
import { assertNever } from './lifecycle.js';
import type { EnsureWorkspaceDecision, RestoreContext, WorkspaceStatus } from './types.js';

/** What the decision needs to know; every value is read by the caller, nothing is fetched here. */
export interface EnsureWorkspaceInput {
  /** Live workspace of the chat, from `WorkspaceRepository.findLiveByChat`, or `null`. */
  liveWorkspace: { id: string; status: WorkspaceStatus } | null;
  /** Image reference the runner would use; named in {@link WorkspaceImageMissing}. */
  image: string;
  /** Whether the Docker host already has that image. */
  imagePresent: boolean;
  /** Context a new workspace would be rebuilt from. */
  restore: RestoreContext;
}

/**
 * Decides whether the turn reuses the chat's workspace or gets a fresh one.
 *
 * The image is checked first: without it no decision can be carried out, and failing early gives
 * the user the actionable "build it with `pnpm infra:image`" message instead of a container error.
 *
 * @param input - Live workspace, image availability and the restore context.
 * @returns `reuse` for a ready workspace, `create` when there is none to reuse.
 * @throws WorkspaceImageMissing When the workspace image is not on the Docker host.
 * @throws WorkspaceBusyError When the workspace is being created, is running a turn, or is
 *   stopping; the caller runs stalled recovery and retries.
 */
export function ensureWorkspaceDecision(input: EnsureWorkspaceInput): EnsureWorkspaceDecision {
  if (!input.imagePresent) {
    throw new WorkspaceImageMissing(input.image);
  }
  const live = input.liveWorkspace;
  if (live === null) {
    return { action: 'create', clone: true, restore: input.restore };
  }
  switch (live.status) {
    case 'READY':
      return { action: 'reuse', workspaceId: live.id };
    case 'DESTROYED':
    case 'FAILED':
      return { action: 'create', clone: true, restore: input.restore };
    case 'CREATING':
    case 'BUSY':
    case 'STOPPING':
      throw new WorkspaceBusyError(live.id, live.status);
    default:
      return assertNever(live.status);
  }
}
