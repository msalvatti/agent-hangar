/**
 * Persistence-level typed errors.
 *
 * Layer: service (persistence).
 *
 * `src/errors.ts` already defines the three error kinds a Prisma repository needs to surface —
 * `NotFoundError`, `LiveWorkspaceExistsError` and `UniqueViolationError` — because the in-memory
 * doubles it backs raise the same ones. Repositories reuse those (re-exported here so callers of
 * this module have a single import) instead of duplicating them under different names, which
 * would let a caller written against one repository implementation fail to catch the same
 * failure raised by the other. Two kinds are genuinely new to this layer:
 * {@link PersistenceMappingError}, for a stored value that no longer matches its domain union, and
 * {@link WorkspaceKindMismatchError}, for a reference that points at the wrong kind of workspace.
 */
import { AgentHangarError } from '../../errors.ts';
import type { AgentHangarErrorOptions } from '../../errors.ts';
import type { WorkspaceKind } from '../../workspace/types.ts';

export { LiveWorkspaceExistsError, NotFoundError, UniqueViolationError } from '../../errors.ts';

/** A stored row holds a value that does not match any literal of its domain union. */
export class PersistenceMappingError extends AgentHangarError {
  declare readonly code: 'PERSISTENCE_MAPPING';

  /**
   * @param detail - What could not be mapped and why.
   * @param options - Optional `cause`.
   */
  constructor(detail: string, options?: AgentHangarErrorOptions) {
    super('PERSISTENCE_MAPPING', detail, options);
  }
}

/**
 * A row was pointed at a workspace of the wrong kind.
 *
 * A `JobRun` runs in a workspace of its own — one run, one container, destroyed when the run ends —
 * and a chat's workspace is the opposite: shared by every turn of the chat and expected to outlive
 * each of them. Pointing a run at one would make the run's teardown destroy a filesystem the chat
 * is still using, and would hang the run's tool log off a container that answers to somebody else.
 * Nothing in the application does this; the error exists so that nothing can begin to.
 *
 * It is raised identically by the Prisma repository and by the in-memory double, because a rule
 * only one of them enforces is a rule that holds in exactly the runs nobody is watching.
 */
export class WorkspaceKindMismatchError extends AgentHangarError {
  declare readonly code: 'WORKSPACE_KIND_MISMATCH';

  /** The workspace that was named. */
  readonly workspaceId: string;

  /**
   * @param workspaceId - Workspace the reference named.
   * @param expected - Kind the reference requires.
   * @param actual - Kind the row actually holds.
   * @param options - Optional `cause`.
   */
  constructor(
    workspaceId: string,
    expected: WorkspaceKind,
    actual: WorkspaceKind,
    options?: AgentHangarErrorOptions,
  ) {
    super(
      'WORKSPACE_KIND_MISMATCH',
      `workspace ${workspaceId} is a ${actual} workspace, and a ${expected} one was required`,
      options,
    );
    this.workspaceId = workspaceId;
  }
}
