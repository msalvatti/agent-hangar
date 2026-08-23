/**
 * Vitest configuration used by Stryker when it mutates `infra/scripts/lib/**`.
 *
 * Layer: config.
 *
 * Only the unit suites of `infra/scripts/lib/**` run. The suites one directory up prove the shell
 * entry points by *spawning* them — `bash` plus a dozen PATH shims per test — and a spawned process
 * is a fresh Node instance that never sees the `__stryker__` global the runner sets, so it always
 * executes unmutated code. Those tests can therefore never kill a mutant; including them would add
 * minutes of process-creation cost to every run and, worse, would let a green subprocess suite read
 * as evidence about code it did not run.
 *
 * The unit settings are restated rather than imported from `vitest.config.ts`: that file describes
 * its suite through `projects`, and merging a second configuration into an array of projects
 * appends rather than replaces, which would run the whole thing twice.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'scripts',
    environment: 'node',
    include: ['infra/scripts/lib/**/*.test.ts'],
    maxWorkers: 3,
    testTimeout: 30_000,
    coverage: { enabled: false },
  },
});
