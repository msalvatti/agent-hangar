/**
 * Unit tests for the system clock.
 *
 * Layer: unit.
 * Goal: `systemClock.now()` returns the current time as a fresh `Date`.
 * Mocks: fake timers pin the wall clock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { systemClock } from './clock.ts';

describe('systemClock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The real clock reads the process time; with fake timers set to a fixed instant the value is
   * exactly that instant, and each call returns a new `Date` (no shared mutable instance).
   */
  it('returns the current time as a new Date each call', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T12:00:00.000Z'));
    const first = systemClock.now();
    const second = systemClock.now();
    expect(first.toISOString()).toBe('2026-08-19T12:00:00.000Z');
    expect(second).not.toBe(first);
  });
});
