/**
 * Stryker 10 mutation-testing configuration of the web app.
 *
 * Layer: config.
 *
 * What is mutated is the code that decides something: the API route handlers and the server
 * modules behind them, and the hooks, services and pure helpers of each feature. A mutant that
 * survives there is a request accepted that should have been refused, a stream that stops
 * reconnecting, a cron expression read as a different time, or a secret shown where it should have
 * been masked.
 *
 * `.tsx` is not mutated. Its dominant mutant is the class-name string literal, and this project
 * forbids tests that assert on class names — the outcome of a class is size, position or colour,
 * which jsdom neither lays out nor resolves, so it belongs to the Playwright suite in `e2e/`.
 * Mutating those files would therefore produce hundreds of mutants that no permitted unit test can
 * kill, and the only way to a green run would be to write the very checks that rule bans. The
 * branching a component does have is reachable through the hooks and helpers it renders, which are
 * mutated here.
 *
 * `testing/**` and `src/mocks/**` are the doubles the suites are written against, `src/test/` is
 * the setup file, and `e2e/` is driven by a browser rather than by Vitest.
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
    'app/api/**/*.ts',
    'src/server/**/*.ts',
    'src/features/**/*.ts',
    'src/shared/**/*.ts',
    '!**/*.test.ts',
    '!**/testing/**',
  ],
  thresholds: { high: 100, low: 100, break: 100 },
  concurrency: 2,
  coverageAnalysis: 'perTest',
  reporters: ['html', 'clear-text', 'progress', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  // Stryker's default is to prepend a type-checking suppression header to every source file it
  // copies into a sandbox, for runners that type-check as they go. Vitest strips types without
  // checking them, so nothing here needs one — and the edit is not free: `vendored.test.ts` hashes
  // the shadcn primitives to prove they are still generator output, and a line added to the top of
  // them makes every digest wrong, which aborts the run before a single mutant is tested.
  disableTypeChecks: false,
  incremental: false,
  cleanTempDir: 'always',
  tempDirName: '.stryker-tmp',
  ignorePatterns: ['dist', 'coverage', 'reports', '.stryker-tmp', '.next', 'test-results'],
};
