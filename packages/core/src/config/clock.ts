/**
 * Clock abstraction so every timestamp written by the app is injectable in tests.
 *
 * Layer: utility.
 */

/** Source of the current time. */
export interface Clock {
  /** Current instant. */
  now(): Date;
}

/** The real clock. */
export const systemClock: Clock = {
  now: () => new Date(),
};
