/**
 * Small runtime assertion for values a caller has already proven present (e.g. a ref that is
 * always attached by the time its handler can run).
 *
 * Layer: shared (utility).
 */

/**
 * Returns `value` unchanged, throwing when it is `null`/`undefined`.
 *
 * @param value - A value expected to be present.
 * @param message - Error message when it is not.
 * @returns `value`, narrowed to exclude `null`/`undefined`.
 * @throws Error when `value` is `null` or `undefined`.
 */
export function assertPresent<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}
