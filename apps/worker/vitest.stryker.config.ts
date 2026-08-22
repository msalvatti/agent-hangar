/**
 * Vitest configuration used only by mutation testing.
 *
 * Layer: config.
 *
 * One flat project rather than the two of `vitest.config.ts`: the `@docker @db @redis` suite needs
 * real infrastructure, which no mutant may depend on. Coverage is off — Stryker decides which
 * tests cover which mutant itself.
 *
 * `dangerouslyIgnoreUnhandledErrors` is what makes the verdicts trustworthy, and it is set here
 * and nowhere else. A mutant that breaks something every module depends on — the logger factory,
 * say — leaves handlers reaching for a method on `undefined` inside a `catch`, which surfaces as
 * an unhandled rejection rather than as a failing assertion. Vitest then reports the run as an
 * error with no results, the test runner hands Stryker no failures, and Stryker records the mutant
 * as **survived** while a hundred tests were in fact failing. Ignoring the unhandled error lets
 * those failures be reported and the mutant be killed on their strength. The real gate keeps the
 * strict behaviour: `pnpm test` reads `vitest.config.ts`, where an unhandled rejection still fails
 * the run.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'node_modules/**'],
    maxWorkers: 3,
    dangerouslyIgnoreUnhandledErrors: true,
    coverage: { enabled: false },
  },
});
