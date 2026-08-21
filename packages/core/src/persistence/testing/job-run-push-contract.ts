/**
 * The contract `JobRunRepository.recordPush` owes every caller, run against any implementation.
 *
 * Layer: test double (contract).
 *
 * A run's container is destroyed the moment the run ends and its event stream is discarded an hour
 * later, so where the run pushed is on the run's row or it is nowhere. Two implementations write
 * that row, and the rule they owe is the same one twice: the last push is the record, and a run
 * that pushed nothing says so.
 *
 * Written once here and called from every suite, for the reason `./workspace-claim-contract.ts`
 * gives — the in-memory double is what most suites run against, so a rule only Postgres enforces
 * is a rule that fails in production only, and a rule only the double enforces is worse still.
 */
import { describe, expect, it } from 'vitest';

import type { JobRunPush } from '../ports.ts';

/** How a suite creates one run and drives its push record. */
export interface JobRunPushContractHarness {
  /**
   * Creates a run with no push recorded.
   *
   * @returns The id of the row it created.
   */
  seed: () => Promise<string>;
  /**
   * Records where the run pushed.
   *
   * @param id - The run.
   * @param push - Branch and commit.
   */
  recordPush: (id: string, push: JobRunPush) => Promise<void>;
  /**
   * Reads back what the row says about the push.
   *
   * @param id - The run.
   * @returns The two columns, or `null` when there is no such row.
   */
  pushOf: (
    id: string,
  ) => Promise<{ workBranch: string | null; lastPushedSha: string | null } | null>;
  /**
   * Records a push against an id no run carries.
   *
   * @param id - An id with no row behind it.
   * @returns The error the implementation raised.
   */
  recordPushOnMissing: (id: string) => Promise<unknown>;
}

/** A push both implementations are given, so the assertions can name it. */
const FIRST: JobRunPush = { workBranch: 'agent/job-first', lastPushedSha: '1111111111111111' };

/** The push that follows it, which is the one the row must end up carrying. */
const SECOND: JobRunPush = { workBranch: 'agent/job-second', lastPushedSha: '2222222222222222' };

/**
 * Registers the `recordPush` contract against one implementation.
 *
 * @param implementation - Name of the implementation, used in the suite title.
 * @param harness - How to seed a run and drive its push record.
 */
export function describeJobRunPushContract(
  implementation: string,
  harness: JobRunPushContractHarness,
): void {
  describe(`${implementation} satisfies the push-record contract`, () => {
    /**
     * A run that has pushed nothing carries neither column, so a reader can tell "did not push"
     * from "pushed somewhere I am not showing you".
     */
    it('starts with no push recorded', async () => {
      const id = await harness.seed();

      expect(await harness.pushOf(id)).toEqual({ workBranch: null, lastPushedSha: null });
    });

    /** Both columns are written together; a branch without its commit describes nothing. */
    it('records both halves of a push', async () => {
      const id = await harness.seed();

      await harness.recordPush(id, FIRST);

      expect(await harness.pushOf(id)).toEqual({
        workBranch: FIRST.workBranch,
        lastPushedSha: FIRST.lastPushedSha,
      });
    });

    /**
     * A run may push more than once, and only the last push describes the branch as it stands. A
     * record that kept the first would point a reader at work that has been moved on from.
     */
    it('keeps the last push, not the first', async () => {
      const id = await harness.seed();

      await harness.recordPush(id, FIRST);
      await harness.recordPush(id, SECOND);

      expect(await harness.pushOf(id)).toEqual({
        workBranch: SECOND.workBranch,
        lastPushedSha: SECOND.lastPushedSha,
      });
    });

    /**
     * A push for a run that is not there is a caller bug, not a silent no-op: the worker reaches
     * this with a run id it created itself, so an id with no row means something else deleted it.
     */
    it('refuses a push for a run that does not exist', async () => {
      const error = await harness.recordPushOnMissing('run-that-never-existed');

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('JobRun');
    });
  });
}
