/**
 * The contract `WorkspaceRepository.claimStatus` owes every caller, run against any implementation.
 *
 * Layer: test double (contract).
 *
 * Two implementations satisfy one port, and a rule only one of them enforces is worse than a rule
 * neither does: the in-memory double is what most suites run against, so a promise it keeps and
 * Postgres breaks is a promise that fails in production only. These assertions are therefore
 * written once and called from both suites — the double's unit tests and the Prisma `@db` ones —
 * rather than living beside whichever implementation was edited last.
 *
 * What is pinned here is only the arbitration guarantee, which is the whole reason the method
 * exists: a claim naming a move the lifecycle forbids is refused, and a claim whose expected status
 * the row has left answers `null`.
 */
import { describe, expect, it } from 'vitest';

import { IllegalTransitionError } from '../../errors.ts';
import type { WorkspaceStatus } from '../../workspace/types.ts';
import type { Workspace } from '../entities.ts';
import type { WorkspaceRepository } from '../ports.ts';

/** How a suite opens one implementation and puts a workspace into a known status. */
export interface WorkspaceClaimContractHarness {
  /** The implementation under test, ready for one test's use. */
  repository: () => WorkspaceRepository;
  /**
   * Creates a workspace and leaves it in `status`.
   *
   * @param status - Status the row should hold when the test starts.
   * @returns The row it created.
   */
  seed: (status: WorkspaceStatus) => Promise<Workspace>;
}

/**
 * Registers the `claimStatus` contract against one implementation.
 *
 * @param implementation - Name of the implementation, used in the suite title.
 * @param harness - How to open it and seed a workspace.
 */
export function describeWorkspaceClaimContract(
  implementation: string,
  harness: WorkspaceClaimContractHarness,
): void {
  describe(`${implementation} satisfies the claimStatus contract`, () => {
    /**
     * A self-transition is refused rather than granted. It would match its own `WHERE` on every
     * attempt, so every concurrent caller would be handed a row and told it had won — which makes
     * "exactly one writer moves the row" false for that case. The lifecycle already calls writing
     * the status a row holds a lost update; this is that rule reaching the write.
     */
    it('refuses a claim whose expected and next status are the same', async () => {
      const workspace = await harness.seed('STOPPING');

      await expect(
        harness.repository().claimStatus(workspace.id, 'STOPPING', 'STOPPING'),
      ).rejects.toBeInstanceOf(IllegalTransitionError);

      expect((await harness.repository().get(workspace.id))?.status).toBe('STOPPING');
    });

    /**
     * A move the lifecycle forbids is refused the same way, and for the same reason it is refused
     * everywhere else: it is a caller naming something impossible, not a caller losing a race, and
     * the two deserve different answers.
     */
    it('refuses a claim the workspace lifecycle does not allow', async () => {
      const workspace = await harness.seed('DESTROYED');

      await expect(
        harness.repository().claimStatus(workspace.id, 'DESTROYED', 'READY'),
      ).rejects.toBeInstanceOf(IllegalTransitionError);
    });

    /**
     * Losing is an answer, not a failure: the row left the status the caller read, so the caller
     * may not act, and it is told so with `null` rather than an error.
     */
    it('answers null when the row has left the expected status', async () => {
      const workspace = await harness.seed('READY');

      expect(await harness.repository().claimStatus(workspace.id, 'READY', 'BUSY')).not.toBeNull();
      expect(await harness.repository().claimStatus(workspace.id, 'READY', 'STOPPING')).toBeNull();
      expect((await harness.repository().get(workspace.id))?.status).toBe('BUSY');
    });
  });
}
