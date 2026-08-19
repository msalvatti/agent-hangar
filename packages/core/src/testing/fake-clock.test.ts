/**
 * Unit tests for FakeClock.
 *
 * Layer: unit.
 * Goal: the clock starts where told, only moves on `advance`/`set`, and never hands out its
 * internal Date instance.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { FakeClock } from './fake-clock.js';

describe('FakeClock', () => {
  /**
   * Default start is a fixed instant so tests that do not care about the date are still
   * deterministic; repeated `now()` calls do not move the clock.
   */
  it('starts at the default instant and stays put', () => {
    const clock = new FakeClock();
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  /**
   * `advance` adds milliseconds (negative allowed) and `set` jumps to an absolute instant.
   */
  it('advances and sets the time', () => {
    const clock = new FakeClock(new Date('2026-08-19T10:00:00.000Z'));
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-08-19T10:01:00.000Z');
    clock.advance(-30_000);
    expect(clock.now().toISOString()).toBe('2026-08-19T10:00:30.000Z');
    clock.set(new Date('2027-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  /**
   * Mutating a returned Date (or the start Date) must not affect the clock: it copies on the
   * way in and on the way out.
   */
  it('isolates its internal state from callers', () => {
    const start = new Date('2026-08-19T10:00:00.000Z');
    const clock = new FakeClock(start);
    start.setFullYear(2000);
    const returned = clock.now();
    returned.setFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-08-19T10:00:00.000Z');
  });
});
