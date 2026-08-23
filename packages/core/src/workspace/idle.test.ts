/**
 * Unit tests for idle-workspace selection.
 *
 * Layer: unit.
 * Goal: only ready workspaces older than the TTL are reaped, the boundary is exclusive, both
 * kinds qualify, the order is stable, and a non-positive TTL is refused.
 * Mocks: `FakeClock` supplies the current instant.
 */
import { describe, expect, it } from 'vitest';

import { FakeClock } from '../testing/fake-clock.ts';

import { idleCutoff, selectIdleWorkspaces } from './idle.ts';
import type { IdleCandidate } from './idle.ts';
import type { WorkspaceStatus } from './types.ts';

/** Configured idle time-to-live, matching the `WORKSPACE_IDLE_TTL_MIN` default. */
const TTL_MIN = 30;

/** The TTL expressed in milliseconds, for building instants relative to the cutoff. */
const TTL_MS = TTL_MIN * 60_000;

/**
 * Builds a candidate workspace.
 *
 * @param id - Workspace id.
 * @param lastActiveAt - When a turn last touched it.
 * @param overrides - Status and kind overrides.
 * @returns A candidate.
 */
function candidate(
  id: string,
  lastActiveAt: Date,
  overrides: Partial<IdleCandidate> = {},
): IdleCandidate {
  return { id, status: 'READY', kind: 'CHAT', lastActiveAt, ...overrides };
}

describe('idleCutoff', () => {
  /**
   * The cutoff is the current instant minus the configured minutes; nothing rounds.
   */
  it('subtracts the TTL from the current instant', () => {
    const now = new FakeClock().now();
    expect(idleCutoff(now, TTL_MIN).toISOString()).toBe('2025-12-31T23:30:00.000Z');
  });

  /**
   * A zero or negative TTL would reap workspaces that a turn is about to use, so it is a
   * configuration bug rather than an aggressive setting.
   */
  it('refuses a non-positive TTL', () => {
    const now = new FakeClock().now();
    // Naming the value, because the caller passed a configured number and has to see which one
    // was refused rather than only that something was.
    expect(() => idleCutoff(now, 0)).toThrow('idleTtlMin must be positive, got 0');
    expect(() => idleCutoff(now, -1)).toThrow('idleTtlMin must be positive, got -1');
  });
});

describe('selectIdleWorkspaces', () => {
  /**
   * The boundary is exclusive: a workspace whose last activity is exactly the TTL ago survives one
   * more tick, so a chat is never reaped in the same minute it was used.
   */
  it('treats the TTL boundary as exclusive', () => {
    const clock = new FakeClock();
    const now = clock.now();
    const atBoundary = candidate('at', new Date(now.getTime() - TTL_MS));
    const past = candidate('past', new Date(now.getTime() - TTL_MS - 1));
    expect(selectIdleWorkspaces([atBoundary, past], { now, idleTtlMin: TTL_MIN })).toEqual([
      'past',
    ]);
  });

  /**
   * Only `READY` qualifies: `BUSY` is running a turn, and `CREATING` and `STOPPING` are transient
   * states another actor owns; terminal rows are not candidates at all.
   */
  it('reaps ready workspaces only', () => {
    const clock = new FakeClock();
    const now = clock.now();
    const old = new Date(now.getTime() - TTL_MS - 1);
    const statuses: WorkspaceStatus[] = ['CREATING', 'BUSY', 'STOPPING', 'DESTROYED', 'FAILED'];
    const candidates = statuses.map((status) => candidate(status, old, { status }));
    expect(selectIdleWorkspaces(candidates, { now, idleTtlMin: TTL_MIN })).toEqual([]);
  });

  /**
   * A job workspace that outlived its run is a leak, so both kinds are reaped; the collector is
   * the repair for a worker that died before its `finally`.
   */
  it('reaps both chat and job workspaces', () => {
    const clock = new FakeClock();
    const now = clock.now();
    const old = new Date(now.getTime() - TTL_MS - 1);
    const candidates = [
      candidate('chat', old, { kind: 'CHAT' }),
      candidate('job', old, { kind: 'JOB' }),
    ];
    expect(selectIdleWorkspaces(candidates, { now, idleTtlMin: TTL_MIN }).toSorted()).toEqual([
      'chat',
      'job',
    ]);
  });

  /**
   * The oldest workspace is reaped first, and ties break by id, so two collectors seeing the same
   * state issue the same commands in the same order.
   */
  it('orders by last activity, then by id', () => {
    const clock = new FakeClock();
    const now = clock.now();
    const older = new Date(now.getTime() - 2 * TTL_MS);
    const newer = new Date(now.getTime() - TTL_MS - 1);
    const candidates = [
      candidate('b-tie', older),
      candidate('recent', newer),
      candidate('a-tie', older),
    ];
    expect(selectIdleWorkspaces(candidates, { now, idleTtlMin: TTL_MIN })).toEqual([
      'a-tie',
      'b-tie',
      'recent',
    ]);
  });

  /**
   * Advancing the clock is what makes a workspace idle; nothing else about it changes.
   */
  it('selects a workspace once the clock passes its TTL', () => {
    const clock = new FakeClock();
    const lastActiveAt = clock.now();
    const candidates = [candidate('ws-1', lastActiveAt)];
    expect(selectIdleWorkspaces(candidates, { now: clock.now(), idleTtlMin: TTL_MIN })).toEqual([]);
    clock.advance(TTL_MS + 1);
    expect(selectIdleWorkspaces(candidates, { now: clock.now(), idleTtlMin: TTL_MIN })).toEqual([
      'ws-1',
    ]);
  });

  /**
   * The TTL is validated even when there is nothing to reap, so a misconfiguration surfaces on the
   * first tick rather than the first idle workspace.
   */
  it('refuses a non-positive TTL', () => {
    expect(() => selectIdleWorkspaces([], { now: new FakeClock().now(), idleTtlMin: 0 })).toThrow(
      RangeError,
    );
  });
});
