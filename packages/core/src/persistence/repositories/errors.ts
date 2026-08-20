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
 * failure raised by the other. The only kind genuinely new to this layer is
 * {@link PersistenceMappingError}, for a stored value that no longer matches its domain union.
 */
import { AgentHangarError } from '../../errors.ts';
import type { AgentHangarErrorOptions } from '../../errors.ts';

export { LiveWorkspaceExistsError, NotFoundError, UniqueViolationError } from '../../errors.ts';

/** A stored row holds a value that does not match any literal of its domain union. */
export class PersistenceMappingError extends AgentHangarError {
  override readonly code = 'PERSISTENCE_MAPPING' as const;

  /**
   * @param detail - What could not be mapped and why.
   * @param options - Optional `cause`.
   */
  constructor(detail: string, options?: AgentHangarErrorOptions) {
    super('PERSISTENCE_MAPPING', detail, options);
  }
}
