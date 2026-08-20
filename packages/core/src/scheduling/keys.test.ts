/**
 * Unit tests for the scheduler-key convention.
 *
 * Layer: unit.
 * Goal: keys and job ids convert both ways without transformation, empty values are refused, and
 * the garbage-collection scheduler constants match the spec.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { GC_CRON, GC_SCHEDULER_KEY, jobIdFromSchedulerKey, toSchedulerKey } from './keys.ts';

describe('scheduler keys', () => {
  /**
   * The key is the job id verbatim; anything else would break the idempotent upsert that editing
   * a job relies on.
   */
  it('converts a job id to its key and back unchanged', () => {
    const jobId = '018f3a2b-6c1d-7f00-9a11-2233445566aa';
    expect(toSchedulerKey(jobId)).toBe(jobId);
    expect(jobIdFromSchedulerKey(toSchedulerKey(jobId))).toBe(jobId);
  });

  /**
   * An empty id would register a scheduler nothing can address, so it is a caller bug rather than
   * a silently accepted key.
   */
  it('rejects empty ids and keys', () => {
    expect(() => toSchedulerKey('')).toThrow(RangeError);
    expect(() => jobIdFromSchedulerKey('')).toThrow(RangeError);
  });

  /**
   * The idle-workspace collector is a scheduler like any other, but its key belongs to no job;
   * the reconciler must therefore know the exact literal to leave alone.
   */
  it('pins the garbage-collection scheduler constants', () => {
    expect(GC_SCHEDULER_KEY).toBe('reap-idle');
    expect(GC_CRON).toBe('*/5 * * * *');
  });
});
