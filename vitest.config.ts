/**
 * Root Vitest configuration: the `scripts` project only.
 *
 * Layer: config.
 *
 * Every workspace package (`packages/*`, `apps/*`) owns its own `vitest.config.ts`, run through
 * `pnpm -r --if-present test`. This file exists solely for `infra/scripts/**` — bash entry points
 * proven by spawning them with PATH shims, and the small TypeScript helpers `doctor.sh` and
 * `rotate-key.sh` delegate to. `pnpm test` runs both: the per-package suites, then
 * `vitest run --project scripts`.
 *
 * `infra/scripts/lib/*.main.ts` files are thin process-wiring entry points (real config, real
 * Prisma client, `process.exit`) with no branching to cover; they are excluded from
 * `coverage.include` by filename pattern, never by an inline coverage-ignore comment.
 *
 * `testTimeout` is raised well above the five-second default because every test here is a real
 * process tree, not a function call: one spawn of the script under test, the `env.sh` subshell it
 * evaluates, and up to a dozen PATH shims, each its own `bash`. A single test therefore pays the
 * machine's process-creation cost ten to twenty times over, and that cost is what a loaded runner
 * inflates — the work itself never grows. The default leaves almost no room for that: on an idle
 * eighteen-core machine the slowest test here already takes 2.1 s, and on the same machine running
 * four copies of this project at once against heavy process-spawning load the slowest took 10.3 s,
 * with dozens of tests over five seconds. Thirty seconds keeps a near threefold margin over that
 * worst measured case while still failing a genuinely hung script in half a minute, which is a
 * twentieth of the CI job budget and far shorter than the whole project's runtime. The precedent
 * is `packages/agent-runtime`, on 20 s for suites that spawn a single real `git` or `bash`; the
 * larger number here is for the larger process tree, not for a different kind of caution.
 *
 * `hookTimeout` keeps its default deliberately: the hooks only kill children and delete temporary
 * directories, they spawn nothing, and no run under that load came near overrunning them.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    maxWorkers: 3,
    projects: [
      {
        test: {
          name: 'scripts',
          environment: 'node',
          include: ['infra/scripts/**/*.test.ts'],
          maxWorkers: 3,
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['infra/scripts/lib/**', 'infra/scripts/testing/**'],
      exclude: ['**/*.test.ts', 'infra/scripts/lib/**/*.main.ts'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
