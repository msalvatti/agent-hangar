/**
 * Deterministic clock for tests.
 *
 * Layer: test double.
 */
import type { Clock } from '../config/clock.ts';

/** A clock that only moves when told to. */
export class FakeClock implements Clock {
  private current: Date;

  /**
   * @param start - Initial instant (defaults to 2026-01-01T00:00:00Z).
   */
  constructor(start: Date = new Date('2026-01-01T00:00:00.000Z')) {
    this.current = new Date(start.getTime());
  }

  /** Current instant (a fresh `Date` each call). */
  now(): Date {
    return new Date(this.current.getTime());
  }

  /**
   * Moves the clock forward.
   *
   * @param ms - Milliseconds to add; negative values move it backwards.
   */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  /**
   * Sets the clock to an absolute instant.
   *
   * @param date - The new current instant.
   */
  set(date: Date): void {
    this.current = new Date(date.getTime());
  }
}
