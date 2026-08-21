/**
 * The contract `TurnRepository.finish` and `JobRunRepository.finish` owe every caller, run against
 * any implementation of either.
 *
 * Layer: test double (contract).
 *
 * Two ports, four implementations, one rule: the first writer of an outcome is the record. Written
 * once here and called from every suite, for the reason `./workspace-claim-contract.ts` gives —
 * the in-memory doubles are what most suites run against, so a rule only Postgres enforces is a
 * rule that fails in production only, and a rule only the double enforces is worse still.
 *
 * A turn and a run are different rows with different signatures, so the harness adapts each to the
 * two questions this contract asks: did the write land, and what does the row say now.
 */
import { describe, expect, it } from 'vitest';

import { LIVE_RUN_STATUSES } from '../../workspace/lifecycle.ts';
import type { TerminalStatus } from '../ports.ts';

/** How a suite creates one run and drives its outcome. */
export interface RunFinishContractHarness {
  /**
   * Creates a live run and leaves it in `status`.
   *
   * @param status - A live status the row should hold when the test starts.
   * @returns The id of the row it created.
   */
  seed: (status: (typeof LIVE_RUN_STATUSES)[number]) => Promise<string>;
  /**
   * Records a terminal outcome.
   *
   * @param id - The row.
   * @param status - Terminal status to record.
   * @returns `true` when the write landed, `false` when it was refused.
   */
  finish: (id: string, status: TerminalStatus) => Promise<boolean>;
  /**
   * Reads back the stored status.
   *
   * @param id - The row.
   * @returns The status, or `null` when there is no such row.
   */
  statusOf: (id: string) => Promise<string | null>;
}

/**
 * Registers the conditional-`finish` contract against one implementation.
 *
 * @param implementation - Name of the implementation, used in the suite title.
 * @param harness - How to seed a run and drive its outcome.
 */
export function describeRunFinishContract(
  implementation: string,
  harness: RunFinishContractHarness,
): void {
  describe(`${implementation} satisfies the conditional finish contract`, () => {
    /**
     * The ordinary case, and the reason the condition is not simply "always refuse": a run that is
     * still live is finished by whoever asks first, from any of the statuses it can be in when the
     * answer arrives.
     */
    it.each(LIVE_RUN_STATUSES)('records an outcome for a %s run', async (status) => {
      const id = await harness.seed(status);

      expect(await harness.finish(id, 'SUCCEEDED')).toBe(true);
      expect(await harness.statusOf(id)).toBe('SUCCEEDED');
    });

    /**
     * The rule itself: a row that already carries an outcome keeps it, and the second writer is
     * told so rather than being allowed to believe it recorded something. This is what stops a
     * cancellation the API has already accepted from being overwritten by the failure the worker
     * was a moment away from writing — and the reverse.
     */
    it('refuses a second outcome and leaves the first one standing', async () => {
      const id = await harness.seed('RUNNING');

      expect(await harness.finish(id, 'CANCELLED')).toBe(true);
      expect(await harness.finish(id, 'FAILED')).toBe(false);
      expect(await harness.statusOf(id)).toBe('CANCELLED');
    });

    /**
     * A row that is not there is refused the same way, and for the same reason `claimStatus`
     * collapses the two: neither tells the caller it recorded an outcome, which is the only thing
     * the answer is about.
     */
    it('refuses an outcome for a row that does not exist', async () => {
      expect(await harness.finish('no-such-run', 'FAILED')).toBe(false);
    });
  });
}
