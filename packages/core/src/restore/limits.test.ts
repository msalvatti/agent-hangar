/**
 * Unit tests for the default turn limits, history budget and branch naming.
 *
 * Layer: unit.
 * Goal: the defaults are the documented numbers, jobs differ from chats only in wall clock, and
 * the generated branch name is the prefixed short id.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import {
  CHAT_WORK_BRANCH_PREFIX,
  DEFAULT_CHAT_TURN_LIMITS,
  DEFAULT_HISTORY_BUDGET,
  DEFAULT_JOB_TURN_LIMITS,
  defaultWorkBranch,
  JOB_WORK_BRANCH_PREFIX,
  WORK_BRANCH_ID_CHARS,
} from './limits.js';

describe('default limits', () => {
  /**
   * The chat defaults are the numbers the interface contract documents; the runtime enforces them
   * inside the container, so a drift here silently changes every turn's ceiling.
   */
  it('pins the chat turn limits', () => {
    expect(DEFAULT_CHAT_TURN_LIMITS).toEqual({
      maxSteps: 40,
      maxTurnMs: 1_200_000,
      toolTimeoutMs: 300_000,
      maxToolOutputBytes: 32_768,
    });
  });

  /**
   * A scheduled run may legitimately take longer than someone waiting at a keyboard, and that is
   * the only thing that differs.
   */
  it('gives scheduled runs a longer wall clock and nothing else', () => {
    expect(DEFAULT_JOB_TURN_LIMITS).toEqual({ ...DEFAULT_CHAT_TURN_LIMITS, maxTurnMs: 1_800_000 });
  });

  /**
   * The history budget is expressed in characters as a deliberate token proxy; pinning it keeps
   * the trade-off visible rather than buried in a builder.
   */
  it('pins the history budget', () => {
    expect(DEFAULT_HISTORY_BUDGET).toEqual({ maxMessages: 60, maxChars: 48_000 });
  });
});

describe('defaultWorkBranch', () => {
  /**
   * The branch is the prefix plus the first characters of the id, which keeps it short enough to
   * read in a pull request list while staying unique in practice.
   */
  it('prefixes the short id', () => {
    expect(defaultWorkBranch('018f3a2b-6c1d-7f00-9a11-2233445566aa')).toBe('agent/018f3a2b');
    expect(WORK_BRANCH_ID_CHARS).toBe(8);
    expect(CHAT_WORK_BRANCH_PREFIX).toBe('agent/');
  });

  /**
   * Scheduled runs use their own prefix so a job branch is distinguishable from a chat branch on
   * the remote.
   */
  it('accepts a custom prefix', () => {
    expect(defaultWorkBranch('018f3a2b-6c1d', JOB_WORK_BRANCH_PREFIX)).toBe('agent/job-018f3a2b');
  });

  /**
   * An id shorter than the cut is used whole rather than padded.
   */
  it('uses a short id whole', () => {
    expect(defaultWorkBranch('abc')).toBe('agent/abc');
  });

  /**
   * An empty id would produce a bare prefix, which every chat would then share.
   */
  it('refuses an empty id', () => {
    expect(() => defaultWorkBranch('')).toThrow(RangeError);
  });
});
