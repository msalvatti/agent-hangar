/**
 * Stryker 10 mutation-testing configuration for the repository's own scripts.
 *
 * Layer: config.
 *
 * What is mutated is `infra/scripts/lib/**`: the TypeScript the shell entry points delegate their
 * decisions to — which secrets are reported as configured, which service probes pass, how a key
 * rotation resumes after an interruption, how a CLI argument list is read. A mutant that survives
 * there is a doctor that reports an instance healthy when it is not, or a rotation that resumes
 * from the wrong point.
 *
 * `*.main.ts` files are excluded: they are process wiring — build the real config, construct the
 * real client, call the module above, `process.exit` — with no branching of their own, which is why
 * they are outside `coverage.include` as well.
 *
 * `plugins` is stated rather than discovered: Stryker looks for plugins by globbing
 * `node_modules/@stryker-mutator/*` relative to the working directory, and under pnpm those
 * packages exist only in the root `node_modules`, which that glob never reaches. (Here the working
 * directory *is* the root, so the glob would work — it is stated anyway so this file reads the same
 * as the package-level ones and keeps working if it ever moves.)
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.stryker.config.ts' },
  mutate: ['infra/scripts/lib/**/*.ts', '!**/*.test.ts', '!**/*.main.ts'],
  thresholds: { high: 100, low: 100, break: 100 },
  concurrency: 2,
  coverageAnalysis: 'perTest',
  reporters: ['html', 'clear-text', 'progress', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  disableTypeChecks: false,
  incremental: false,
  cleanTempDir: 'always',
  tempDirName: '.stryker-tmp',
  ignorePatterns: [
    'dist',
    'coverage',
    'reports',
    '.stryker-tmp',
    '.next',
    'test-results',
    'apps/*/.next',
    'apps/*/coverage',
    'apps/*/reports',
    'packages/*/coverage',
    'packages/*/reports',
  ],
};
