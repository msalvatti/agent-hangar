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
