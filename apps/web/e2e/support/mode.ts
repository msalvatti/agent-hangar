/**
 * The two modes the end-to-end suite runs in, and the guard specs use to stop at the boundary.
 *
 * Layer: test support (pure).
 *
 * `mock` runs the Next dev server against the MSW handlers: no Docker, no worker, no database.
 * Every selector and page-object interaction is still exercised, so the suite proves the UI
 * contract it is written against. `real` runs the full stack. An assertion that cannot hold
 * without the real stack is skipped in `mock` with the reason spelled out, never silently
 * dropped.
 */

/** How the suite is being run. */
export type E2eMode = 'mock' | 'real';

/** Environment variable selecting the mode. */
export const MODE_ENV = 'E2E_MODE';

/** Mode used when {@link MODE_ENV} is unset: the full stack, so nothing degrades by accident. */
export const DEFAULT_MODE: E2eMode = 'real';

/** The modes {@link readMode} accepts. */
const MODES: readonly E2eMode[] = ['mock', 'real'];

/** Environment shape {@link readMode} reads. */
export type ModeEnv = Readonly<Partial<Record<string, string>>>;

/**
 * Reads the mode from the environment.
 *
 * @param env - Environment to read.
 * @returns The selected mode, or {@link DEFAULT_MODE} when unset or empty.
 * @throws Error naming the accepted values when the variable holds anything else. A typo must
 *   not silently fall back to a mode that skips half the assertions.
 */
export function readMode(env: ModeEnv): E2eMode {
  const raw = env[MODE_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_MODE;
  }
  const value = raw.trim();
  const mode = MODES.find((candidate) => candidate === value);
  if (mode === undefined) {
    throw new Error(`${MODE_ENV} must be one of ${MODES.join(', ')}, got "${value}"`);
  }
  return mode;
}

/** The part of Playwright's `test` object {@link skipUnlessReal} needs. */
export interface SkippableTest {
  skip(condition: boolean, description: string): void;
}

/**
 * Skips the rest of the current test when the real stack is not running.
 *
 * @param test - Playwright's `test` object.
 * @param mode - The mode the suite is running in.
 * @param reason - What the following assertions need, named in the skip report.
 */
export function skipUnlessReal(test: SkippableTest, mode: E2eMode, reason: string): void {
  test.skip(mode === 'mock', `needs real stack: ${reason}`);
}
