/**
 * Workspace-specific domain errors.
 *
 * Layer: domain.
 */
import { AgentHangarError } from '../errors.js';
import type { AgentHangarErrorOptions } from '../errors.js';

import type { WorkspaceStatus } from './types.js';

/**
 * A chat's workspace is in a transient state, so no turn can start against it yet.
 *
 * `CREATING`, `BUSY` and `STOPPING` all mean another actor owns the workspace right now. The
 * worker answers this by running stalled recovery — the previous owner may have crashed — and
 * retrying, rather than by creating a second workspace, which the one-live-workspace-per-chat
 * invariant forbids.
 */
export class WorkspaceBusyError extends AgentHangarError {
  override readonly code = 'WORKSPACE_BUSY' as const;
  /** Workspace that is not available. */
  readonly workspaceId: string;
  /** Status that made it unavailable. */
  readonly status: WorkspaceStatus;

  /**
   * @param workspaceId - Workspace that is not available.
   * @param status - Status that made it unavailable.
   * @param options - Optional `cause`.
   */
  constructor(workspaceId: string, status: WorkspaceStatus, options?: AgentHangarErrorOptions) {
    super(
      'WORKSPACE_BUSY',
      `workspace ${workspaceId} is ${status}; resolve it (stalled recovery or wait) before ensuring a workspace for this chat`,
      options,
    );
    this.workspaceId = workspaceId;
    this.status = status;
  }
}
