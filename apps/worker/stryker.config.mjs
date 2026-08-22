/**
 * Stryker 10 mutation-testing configuration of the worker.
 *
 * Layer: config.
 *
 * The worker is where a turn actually happens: it claims a job, provisions a workspace, streams the
 * model's events into Postgres and Redis, and tears the container down afterwards. A mutant that
 * survives here is a job claimed twice, a cancellation ignored, a workspace left running, or a
 * scheduled run whose next time drifts — none of which a coverage percentage can rule out.
 *
 * Every module the project authors is mutated. `main.ts` is the composition root (real clients,
 * process signals, `process.exit`), whose logic lives in `boot.ts`, `container.ts` and `app.ts`;
 * `testing/**` holds the doubles the suites are written against; `integration/**` needs Docker,
 * Postgres and Redis and must never be what decides whether a mutant lives.
 *
 * `plugins` is stated rather than discovered: Stryker looks for plugins by globbing
 * `node_modules/@stryker-mutator/*` relative to the working directory, and under pnpm those
 * packages exist only in the root `node_modules`, which that glob never reaches.
 *
 * Never combine a scoped `--mutate` run with `incremental: true` — the report would mix fresh
 * verdicts with cached ones for files the run never touched. For scoped iteration use
 * `--incrementalFile .stryker-tmp/inc-scoped.json`, and read the per-file table rather than the
 * `All files` line.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.stryker.config.ts' },
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/main.ts',
    '!src/testing/**',
    '!src/integration/**',
  ],
  thresholds: { high: 100, low: 100, break: 100 },
  concurrency: 2,
  coverageAnalysis: 'perTest',
  reporters: ['html', 'clear-text', 'progress', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  incremental: false,
  cleanTempDir: 'always',
  tempDirName: '.stryker-tmp',
  ignorePatterns: ['dist', 'coverage', 'reports', '.stryker-tmp', '.next'],
};
