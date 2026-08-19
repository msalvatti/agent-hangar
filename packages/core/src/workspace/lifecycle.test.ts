/**
 * Unit tests for the workspace and run transition tables.
 *
 * Layer: unit.
 * Goal: both tables match the documented lifecycles exactly, self-transitions and resurrections
 * are refused, and refusal is the typed domain error naming subject, source and target.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { AgentHangarError, IllegalTransitionError } from '../errors.js';

import {
  assertNever,
  assertRunTransition,
  assertTransition,
  assertWorkspaceTransition,
  canTransition,
  isLiveWorkspaceStatus,
  isTerminalRunStatus,
  RUN_TRANSITIONS,
  WORKSPACE_TRANSITIONS,
} from './lifecycle.js';

describe('transition tables', () => {
  /**
   * The whole workspace table is pinned in one assertion: reading it as a table is how a reviewer
   * checks it against the spec, and a per-edge test would hide an accidentally added successor.
   */
  it('pins the workspace transition table', () => {
    expect(WORKSPACE_TRANSITIONS).toEqual({
      CREATING: ['READY', 'FAILED', 'DESTROYED'],
      READY: ['BUSY', 'STOPPING', 'DESTROYED', 'FAILED'],
      BUSY: ['READY', 'STOPPING', 'FAILED', 'DESTROYED'],
      STOPPING: ['DESTROYED', 'FAILED'],
      FAILED: ['DESTROYED'],
      DESTROYED: [],
    });
  });

  /**
   * The run table is shared by chat turns and scheduled job runs, whose statuses are the same
   * union; a divergence would fail to compile before it could fail here.
   */
  it('pins the run transition table', () => {
    expect(RUN_TRANSITIONS).toEqual({
      QUEUED: ['PREPARING', 'FAILED', 'CANCELLED'],
      PREPARING: ['RUNNING', 'FAILED', 'CANCELLED'],
      RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
      SUCCEEDED: [],
      FAILED: [],
      CANCELLED: [],
    });
  });
});

describe('canTransition', () => {
  /**
   * The ordinary life of a chat workspace — created, ready, busy for a turn, ready again, finally
   * destroyed — is allowed end to end.
   */
  it('allows the happy path of a chat workspace', () => {
    expect(canTransition(WORKSPACE_TRANSITIONS, 'CREATING', 'READY')).toBe(true);
    expect(canTransition(WORKSPACE_TRANSITIONS, 'READY', 'BUSY')).toBe(true);
    expect(canTransition(WORKSPACE_TRANSITIONS, 'BUSY', 'READY')).toBe(true);
    expect(canTransition(WORKSPACE_TRANSITIONS, 'READY', 'DESTROYED')).toBe(true);
  });

  /**
   * A destroyed container cannot come back, and writing the status a row already has is a
   * lost-update bug rather than a harmless no-op.
   */
  it('refuses resurrection and self-transitions', () => {
    expect(canTransition(WORKSPACE_TRANSITIONS, 'DESTROYED', 'READY')).toBe(false);
    expect(canTransition(WORKSPACE_TRANSITIONS, 'READY', 'READY')).toBe(false);
    expect(canTransition(RUN_TRANSITIONS, 'SUCCEEDED', 'RUNNING')).toBe(false);
    expect(canTransition(RUN_TRANSITIONS, 'RUNNING', 'RUNNING')).toBe(false);
  });
});

describe('assertTransition', () => {
  /**
   * An allowed transition returns without a value, so callers can use it as a guard clause.
   */
  it('passes an allowed transition', () => {
    expect(() => {
      assertWorkspaceTransition('CREATING', 'READY', 'ws-1');
    }).not.toThrow();
    expect(() => {
      assertRunTransition('QUEUED', 'PREPARING', 'turn-1');
    }).not.toThrow();
  });

  /**
   * A refusal is the typed domain error, so the API layer maps it to a code without matching on
   * text, and the message still names the subject, the source and the target.
   */
  it('throws IllegalTransitionError naming subject, source and target', () => {
    expect.assertions(6);
    try {
      assertWorkspaceTransition('DESTROYED', 'READY', 'ws-1');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect(error).toBeInstanceOf(AgentHangarError);
      const failure = error as IllegalTransitionError;
      expect(failure.entity).toBe('workspace ws-1');
      expect(failure.from).toBe('DESTROYED');
      expect(failure.to).toBe('READY');
      expect(failure.message).toContain('workspace ws-1 cannot transition from DESTROYED to READY');
    }
  });

  /**
   * A run cannot skip preparation: finishing something that never started would record a duration
   * for work that never happened.
   */
  it('refuses a run that skips states', () => {
    expect(() => {
      assertRunTransition('QUEUED', 'SUCCEEDED', 'run-1');
    }).toThrow(IllegalTransitionError);
  });

  /**
   * The generic form works on any table, which is what lets the persistence layer share one guard
   * across workspaces, turns and job runs.
   */
  it('works on any table', () => {
    const table = { on: ['off'], off: ['on'] } as const;
    expect(() => {
      assertTransition(table, 'on', 'on', 'switch');
    }).toThrow(IllegalTransitionError);
  });
});

describe('status classifiers', () => {
  /**
   * The live set mirrors the partial unique index that enforces one live workspace per chat, so
   * every status is classified explicitly.
   */
  it('classifies every workspace status as live or not', () => {
    expect(isLiveWorkspaceStatus('CREATING')).toBe(true);
    expect(isLiveWorkspaceStatus('READY')).toBe(true);
    expect(isLiveWorkspaceStatus('BUSY')).toBe(true);
    expect(isLiveWorkspaceStatus('STOPPING')).toBe(true);
    expect(isLiveWorkspaceStatus('DESTROYED')).toBe(false);
    expect(isLiveWorkspaceStatus('FAILED')).toBe(false);
  });

  /**
   * Terminal means "no successor left", which is derived from the table rather than duplicated,
   * so the two can never disagree.
   */
  it('classifies every run status as terminal or not', () => {
    expect(isTerminalRunStatus('QUEUED')).toBe(false);
    expect(isTerminalRunStatus('PREPARING')).toBe(false);
    expect(isTerminalRunStatus('RUNNING')).toBe(false);
    expect(isTerminalRunStatus('SUCCEEDED')).toBe(true);
    expect(isTerminalRunStatus('FAILED')).toBe(true);
    expect(isTerminalRunStatus('CANCELLED')).toBe(true);
  });
});

describe('assertNever', () => {
  /**
   * The exhaustiveness guard is only reachable when a value crosses a boundary untyped, such as a
   * status column written by a newer build; it must report the value instead of returning.
   */
  it('throws with the offending value', () => {
    const impossible = 'PARKED' as unknown as never;
    expect(() => assertNever(impossible)).toThrow(/unhandled case: "PARKED"/);
  });
});
