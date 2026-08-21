/**
 * Vitest configuration of the web app (jsdom + React Testing Library).
 *
 * Layer: config.
 *
 * Two projects, the same split `packages/core` uses: `unit` (default `pnpm test`) excludes
 * `*.integration.test.{ts,tsx}`, and `integration` (`pnpm test:integration`) runs only those —
 * currently the Redis-backed SSE and retry suites, which need the compose Redis.
 *
 * Coverage is collected over the unit project with 100 % thresholds. It measures the whole package
 * — `src/**` and the App Router tree in `app/**` — rather than a list of paths one per lane: a
 * list only measures what someone remembered to add, so a file nobody claimed was measured by
 * nobody and the 100 % said nothing about it. Everything now starts measured, and the exclusions
 * below say, one by one, why a path is not code this project authors. "Hard to test" is not a
 * reason to appear there; a file that is hard to test is a file whose test is missing.
 */
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { VENDORED_UI_COVERAGE_EXCLUDE } from './src/shared/ui/vendored.ts';

export default defineConfig({
  test: {
    maxWorkers: 3,
    projects: [
      {
        plugins: [react()],
        resolve: {
          alias: {
            '@/app': fileURLToPath(new URL('./app', import.meta.url)),
            '@': fileURLToPath(new URL('./src', import.meta.url)),
          },
        },
        test: {
          name: 'unit',
          environment: 'jsdom',
          environmentOptions: {
            jsdom: {
              url: 'http://localhost:3000',
            },
          },
          globals: false,
          setupFiles: [
            './src/test/setup.ts',
            './src/mocks/vitest.ts',
            './src/shared/repo-picker/testing/setup.ts',
          ],
          include: ['src/**/*.test.{ts,tsx}', 'app/**/*.test.{ts,tsx}', 'e2e/**/*.test.ts'],
          exclude: [
            'src/**/*.integration.test.{ts,tsx}',
            'e2e/**/*.spec.ts',
            'node_modules/**',
            '.next/**',
          ],
          maxWorkers: 3,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.integration.test.{ts,tsx}'],
          maxWorkers: 1,
        },
      },
    ],
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: [
        'src/**/*.{ts,tsx}',
        'app/**/*.{ts,tsx}',
        // End-to-end harness, the modules a unit test can decide. `gitserver.ts`, `docker.ts`,
        // `db.ts`, `process.ts`, `worker.ts`, `heartbeat.ts`, `prepare-stack.ts`, `stack.ts`,
        // `stack-state.ts`, the page objects and the Playwright hooks spawn processes, signal
        // them, open sockets or drive a browser, so the end-to-end run is what exercises them.
        // Where one of those modules holds a decision worth pinning it carries its own unit test
        // without the whole module being measured: `worker.ts`'s command-line matcher, which
        // decides whether a recorded process id may be signalled, and `master-key.ts`, which is
        // measured here because what it settles — the permissions a key file ends up with — is a
        // property of the real file system rather than of a value it could be handed.
        'e2e/support/{api,constants,env,github-stub,health,master-key,mode,selectors}.ts',
        'e2e/fake-provider/script.ts',
      ],
      exclude: [
        // Tests, which are the measurement rather than the measured.
        '**/*.test.{ts,tsx}',
        // The shadcn primitives, which the CLI wrote from the registry named in `components.json`
        // and nobody has edited since. Holding generated code to 100 % lines and branches buys
        // nothing that could ever fail for a reason worth acting on. The list is enumerated in
        // `src/shared/ui/vendored.ts` and checked by `vendored.test.ts`, which re-hashes every
        // file behind it: edit one and the digest stops matching, so the file leaves this
        // exclusion and comes under measurement instead of staying hidden behind it. That is why
        // `button.tsx`, `sheet.tsx`, `sonner.tsx`, `command.tsx`, `dropdown-menu.tsx`,
        // `switch.tsx` and `tabs.tsx` are measured — each carries a decision of this project's
        // own.
        ...VENDORED_UI_COVERAGE_EXCLUDE,
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
