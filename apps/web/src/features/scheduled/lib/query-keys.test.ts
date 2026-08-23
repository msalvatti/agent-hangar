/**
 * Unit tests for the scheduled feature's query keys.
 *
 * Layer: unit.
 * Goal: each key is written out, and the four are distinct from one another — they are the names
 * views are registered under and mutations invalidate by, and the hooks that do each are in
 * different files.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { JOBS_KEY, jobKey, runKey, runsKey } from './query-keys';

describe('scheduled query keys', () => {
  /**
   * Written out rather than derived: the point of the module is that both ends of the contract
   * agree on these exact strings, and a key compared against itself agrees with anything.
   */
  it('names each view', () => {
    expect(JOBS_KEY).toStrictEqual(['jobs']);
    expect(jobKey('job-1')).toStrictEqual(['job', 'job-1']);
    expect(runsKey('job-1')).toStrictEqual(['runs', 'job-1']);
    expect(runKey('run-1')).toStrictEqual(['run', 'run-1']);
  });

  /**
   * And they are four different names. Invalidation matches on a prefix, so two views sharing a
   * prefix reload together — a job's own view and its run history are refreshed by different
   * actions, and one collapsed into the other spends a request on every toggle of a switch.
   */
  it('keeps the four apart', () => {
    const keys = [JOBS_KEY, jobKey('job-1'), runsKey('job-1'), runKey('job-1')].map((key) =>
      JSON.stringify(key),
    );

    expect(new Set(keys).size).toBe(keys.length);
  });
});
