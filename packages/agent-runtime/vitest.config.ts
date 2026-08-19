/**
 * Vitest configuration of the agent runtime.
 *
 * Layer: config.
 *
 * Coverage is always on with 100 % thresholds over `src/**`; `src/bin.ts` is the process entry
 * point (top-level await, `process.argv`, `process.exitCode`) and is excluded — everything it
 * calls lives in `cli.ts`, which is fully tested with in-memory streams.
 *
 * `testTimeout` is raised because several suites spawn real `git` and `bash` processes against a
 * temporary directory standing in for `/workspace`.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'agent-runtime',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    maxWorkers: 3,
    testTimeout: 20000,
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**'],
      exclude: ['**/*.test.ts', 'src/bin.ts'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
