/**
 * Vitest configuration used by Stryker when it mutates this package.
 *
 * Layer: config.
 *
 * Stryker copies the package into `.stryker-tmp/sandbox-N/` and runs the suite from there, which
 * moves every file two directories deeper than it sits in the repository. Two families of tests
 * cannot survive that move, so they are excluded here rather than weakened in place:
 *
 *   * the repository gates in `src/config` that reach *outside* the package — they derive the
 *     repository root by climbing a fixed number of directories from `import.meta.url`, so inside
 *     the sandbox the same climb lands on `packages/core` and the read fails with `ENOENT`. They
 *     assert facts about manifests, shell scripts and build output rather than about any mutated
 *     module, so nothing measurable is lost by leaving them out of a mutation run. The four gates
 *     in the same folder that only exercise their own module — `clock`, `declaration-specifiers`,
 *     `instance`, `schema` — stay in, and so do the modules they cover;
 *
 *   * the `@db` / `@redis` / `@docker` suites, which need the compose stack and must never be what
 *     decides whether a mutant lives.
 *
 * The unit settings are restated rather than imported from `vitest.config.ts`: that file describes
 * its suites through `projects`, and merging a second configuration into an array of projects
 * appends rather than replaces, which would run each suite twice. Keep the two `include` patterns
 * in step when either changes.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [
      'src/**/*.integration.test.ts',
      'src/persistence/generated/**',
      'src/config/askpass-script.test.ts',
      'src/config/declaration-specifiers-dist.test.ts',
      'src/config/dev-conditions.test.ts',
      'src/config/env-script.test.ts',
      'src/config/integration-wrapper.test.ts',
      'src/config/relative-specifiers.test.ts',
      'src/config/suppressions-gate.test.ts',
      'src/config/tooling-scripts.test.ts',
    ],
  },
});
