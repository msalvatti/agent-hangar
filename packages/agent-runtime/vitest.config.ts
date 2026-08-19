/**
 * Vitest configuration of @agent-hangar/agent-runtime.
 *
 * Layer: config.
 *
 * Coverage is always on with 100 % thresholds over `src/**`. The package has no runtime code yet
 * (the agent runtime lane adds it together with its tests), so the run passes with no tests.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'agent-runtime',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    maxWorkers: 3,
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**'],
      exclude: ['**/*.test.ts', 'src/index.ts'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
