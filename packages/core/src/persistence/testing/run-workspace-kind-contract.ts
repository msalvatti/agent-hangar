/**
 * The contract `JobRunRepository.setStatus` owes every caller about the workspace it is handed,
 * run against any implementation.
 *
 * Layer: test double (contract).
 *
 * Two implementations, one rule: a run's workspace is a workspace built for a run. Written once
 * here and called from every suite, for the reason `./workspace-claim-contract.ts` gives — the
 * in-memory doubles are what most suites run against, so a rule only Postgres enforces is a rule
 * that fails in production only, and a rule only the double enforces is worse still. This one had
 * neither side: the column was a plain foreign key to `Workspace`, so a run could be pointed at a
 * chat's workspace and would then destroy it, on both implementations, silently.
 */
import { describe, expect, it } from 'vitest';

import { NotFoundError } from '../../errors.ts';
import type { WorkspaceKind } from '../../workspace/types.ts';
import { WorkspaceKindMismatchError } from '../repositories/errors.ts';

/** How a suite creates a run, creates a workspace and points one at the other. */
export interface RunWorkspaceKindContractHarness {
  /**
   * Creates a run in a status that may still take a workspace.
   *
   * @returns The id of the row it created.
   */
  seedRun: () => Promise<string>;
  /**
   * Creates a workspace of the given kind.
   *
   * @param kind - What the workspace serves.
   * @returns The id of the row it created.
   */
  seedWorkspace: (kind: WorkspaceKind) => Promise<string>;
  /**
   * Points a run at a workspace, as the processor does when preparation succeeds.
   *
   * @param runId - The run.
   * @param workspaceId - The workspace it is being given.
   */
  attach: (runId: string, workspaceId: string) => Promise<void>;
  /**
   * Reads back the workspace a run holds.
   *
   * @param runId - The run.
   * @returns The workspace id, or `null` when it holds none.
   */
  workspaceIdOf: (runId: string) => Promise<string | null>;
}

/**
 * Registers the workspace-kind contract against one implementation.
 *
 * @param implementation - Name of the implementation, used in the suite title.
 * @param harness - How to seed the two rows and attach one to the other.
 */
export function describeRunWorkspaceKindContract(
  implementation: string,
  harness: RunWorkspaceKindContractHarness,
): void {
  describe(`${implementation} constrains the workspace a run may hold`, () => {
    /**
     * The ordinary case, and the reason the rule is not simply "refuse": a run provisions a
     * workspace of its own and records it before taking it, which is the only durable link back
     * to the container if the process dies between the two writes.
     */
    it('records a job workspace', async () => {
      const runId = await harness.seedRun();
      const workspaceId = await harness.seedWorkspace('JOB');

      await harness.attach(runId, workspaceId);

      expect(await harness.workspaceIdOf(runId)).toBe(workspaceId);
    });

    /**
     * The rule itself. A chat's workspace is shared by every turn of the chat and is expected to
     * survive them; a run destroys its workspace when it ends. Accepting the reference would mean
     * a scheduled job quietly deleting a chat's filesystem — and the run would keep no record of
     * having done it, because the container it tore down was never its own.
     */
    it('refuses a chat workspace and leaves the run holding none', async () => {
      const runId = await harness.seedRun();
      const workspaceId = await harness.seedWorkspace('CHAT');

      await expect(harness.attach(runId, workspaceId)).rejects.toThrow(WorkspaceKindMismatchError);
      expect(await harness.workspaceIdOf(runId)).toBeNull();
    });

    /**
     * An id no workspace carries is refused too, and told apart from a workspace of the wrong
     * kind: the two mean different things to whoever has to read the failure — one is a reference
     * to something that never existed, the other a reference to the wrong thing.
     */
    it('refuses an id no workspace carries', async () => {
      const runId = await harness.seedRun();

      await expect(harness.attach(runId, 'no-such-workspace')).rejects.toThrow(NotFoundError);
      expect(await harness.workspaceIdOf(runId)).toBeNull();
    });
  });
}
