/**
 * Vitest configuration of the worker.
 *
 * Layer: config.
 *
 * Coverage is always on with 100 % thresholds over `src/**`; `src/main.ts` is the composition
 * root (real clients, process signals, `process.exit`) and is excluded — its logic lives in
 * `boot.ts`, `container.ts` and `app.ts`, which are fully tested with fakes.
 *
 * The `@docker @db @redis` suite lives in `src/integration` and is registered as a second project
 * only when `DOCKER_AVAILABLE=1`, which `pnpm --filter worker test:integration` sets. A plain
 * `vitest run` therefore never picks it up, so the unit gate stays runnable on a machine — or a CI
 * job — without a Docker daemon, while the suite itself still refuses to skip silently once it is
 * selected (see `src/integration/describe-docker.ts`).
 */
import { defineConfig } from 'vitest/config';

/** Whether the caller asked for the Docker suite. */
const dockerSuiteRequested = process.env.DOCKER_AVAILABLE === '1';

/** The unit project: everything except the integration suite. */
const unitProject = {
  test: {
    name: 'unit',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
    maxWorkers: 3,
  },
};

/** The integration project: real Docker, Postgres and Redis. */
const integrationProject = {
  test: {
    name: 'integration',
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
};

export default defineConfig({
  test: {
    maxWorkers: 3,
    projects: dockerSuiteRequested ? [unitProject, integrationProject] : [unitProject],
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**'],
      // `*.integration-helper.ts` is the harness the Docker suite composes itself from: it runs
      // only under that suite, which coverage is not collected over, so counting it would demand
      // unit tests for wiring whose whole point is to touch real infrastructure.
      exclude: ['**/*.test.ts', '**/*.integration-helper.ts', 'src/main.ts'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
