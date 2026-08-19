/**
 * Vitest configuration of the worker.
 *
 * Layer: config.
 *
 * Coverage is always on with 100 % thresholds over `src/**`; `src/main.ts` is the composition
 * root (real clients, process signals, `process.exit`) and is excluded — its logic lives in
 * `boot.ts`, which is fully tested with fakes.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'worker',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    maxWorkers: 3,
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**'],
      exclude: ['**/*.test.ts', 'src/main.ts'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
