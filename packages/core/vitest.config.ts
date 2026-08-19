/**
 * Vitest configuration of @agent-hangar/core.
 *
 * Layer: config.
 *
 * Two projects: `unit` (default `pnpm test`) and `integration` (`*.integration.test.ts`, needs the
 * compose Postgres/Redis; `pnpm test:integration`). Coverage is collected over the unit project
 * with 100 % thresholds on every path listed in `coverage.include`; each lane appends its own
 * paths, one line per lane, at the end of the list.
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
      include: [
        'src/agent-protocol/**',
        'src/config/**',
        'src/errors.ts',
        'src/api/**',
        'src/queues/**',
        'src/testing/**',
        'src/persistence/client.ts',
        'src/persistence/testing/**',
        'src/persistence/repositories/**',
        'src/repo-url.ts',
        'src/secrets/**',
        'src/redaction/**',
        'src/logging/**',
        'src/model/openai/**',
        'src/model/registry.ts',
        'src/runner/docker/**',
        'src/scheduling/**',
        'src/workspace/**',
        'src/restore/**',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.integration-helper.ts',
        'src/**/types.ts',
        'src/index.ts',
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
