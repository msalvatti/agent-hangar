/**
 * Unit tests for the scheduled-job overlap policy.
 *
 * Layer: unit.
 * Goal: a tick is skipped exactly while a previous run is executing, and the recorded reason is
 * the literal string the UI and the `JobRun.error` column carry.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { decideOverlap, OVERLAP_POLICY, OVERLAP_SKIP_REASON } from './overlap.js';

describe('decideOverlap', () => {
  /**
   * With no run in flight the tick proceeds, which is the ordinary case.
   */
  it('runs when the job is idle', () => {
    expect(decideOverlap({ runningRun: null })).toEqual({ action: 'run' });
  });

  /**
   * A run still executing suppresses the tick; queueing instead would let a slow job accumulate
   * one container per missed tick.
   */
  it('skips when a previous run is still executing', () => {
    expect(decideOverlap({ runningRun: { id: 'run-1' } })).toEqual({
      action: 'skip',
      reason: 'previous run still running',
    });
  });

  /**
   * The policy name and the reason text are part of the product surface (spec 04 (c) guarantees
   * and the scheduled-jobs UI), so both are pinned.
   */
  it('pins the policy and the reason text', () => {
    expect(OVERLAP_POLICY).toBe('skip');
    expect(OVERLAP_SKIP_REASON).toBe('previous run still running');
  });
});
