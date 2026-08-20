/**
 * Vitest configuration of @agent-hangar/core.
 *
 * Layer: config.
 *
 * Two projects: `unit` (default `pnpm test`) and `integration` (`*.integration.test.ts`, needs the
 * compose Postgres/Redis; `pnpm test:integration`). Coverage is collected over the unit project
 * with 100 % thresholds.
 *
 * Measurement covers `src/**` as a whole rather than an enumerated list of paths: a list has to be
 * extended by whoever adds a folder, and a folder nobody adds to it is a folder the thresholds say
 * nothing about. Every exclusion below therefore has to argue that the path is not code this
 * repository authors — "it is hard to test" is not that argument.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    maxWorkers: 3,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts', 'src/persistence/generated/**'],
          maxWorkers: 3,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.integration.test.ts'],
          maxWorkers: 1,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      // Always on: the 100 % thresholds are a gate of every run, not an opt-in report.
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**'],
      exclude: [
        // The tests themselves: they are the measurement, not the thing measured.
        '**/*.test.ts',
        // Prisma client output. `prisma generate` writes it, `.gitignore` keeps it out of the
        // repository, and every schema change rewrites it wholesale — nothing here authors a line
        // of it. Measuring it would also make the gate depend on whether a checkout happens to
        // have run `pnpm db:generate` yet, so the same tree would pass or fail for reasons that
        // have nothing to do with the tests.
        'src/persistence/generated/**',
      ],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
