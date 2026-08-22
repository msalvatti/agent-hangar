/**
 * Stryker 10 mutation-testing configuration of `@agent-hangar/core`.
 *
 * Layer: config.
 *
 * Coverage says a line ran; mutation says a test would have noticed had the line been wrong. This
 * package holds the parts of the product where a silent defect is expensive — the envelope
 * encryption of the stored credentials, the redaction that keeps them out of every transcript, the
 * cron arithmetic that decides when a job runs, the workspace state machine, the restore window
 * and the agent protocol codec — so the whole of `src` is mutated rather than a chosen list.
 *
 * Two paths are excluded, neither of them for being hard to test: `persistence/generated` is what
 * `prisma generate` writes and no line of it is authored here, and `testing` holds the doubles the
 * suites are written against rather than code that ships.
 *
 * `plugins` is stated rather than discovered: Stryker looks for plugins by globbing
 * `node_modules/@stryker-mutator/*` relative to the working directory, and under pnpm those
 * packages exist only in the root `node_modules`, which that glob never reaches. Without this line
 * the run dies with `Cannot find TestRunner plugin "vitest"`.
 *
 * `vitest.configFile` points at a Stryker-specific Vitest configuration because several suites
 * cannot run from a sandbox copy of the package; that file explains which and why.
 *
 * Never combine a scoped `--mutate` run with `incremental: true` — the report would mix fresh
 * verdicts with cached ones for files the run never touched. For scoped iteration use
 * `--incrementalFile .stryker-tmp/inc-scoped.json`, and read the per-file table rather than the
 * `All files` line. Every score that gets reported comes from a full run with incremental off.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.stryker.config.ts' },
  mutate: ['src/**/*.ts', '!src/**/*.test.ts', '!src/persistence/generated/**', '!src/testing/**'],
  // The gate this package is held to. A survivor is a defect the suite cannot see, so the only
  // score that closes the lane is the whole of it.
  thresholds: { high: 100, low: 100, break: 100 },
  // Two test-runner processes. The vitest runner pins its own pool to a single worker, so peak
  // memory is two workers rather than two times the package's `maxWorkers`. Concurrency never
  // rises above this locally: `Timeout` is measured in wall-clock, and a loaded machine changes
  // verdicts rather than merely slowing them down.
  concurrency: 2,
  coverageAnalysis: 'perTest',
  reporters: ['html', 'clear-text', 'progress', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  incremental: false,
  // The default (`true`) only cleans up after a passing run, and a leftover sandbox poisons the
  // next one.
  cleanTempDir: 'always',
  tempDirName: '.stryker-tmp',
  // Build output, reports and the sandbox itself are copied into every sandbox otherwise.
  ignorePatterns: ['dist', 'coverage', 'reports', '.stryker-tmp'],
};
