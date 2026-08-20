/**
 * Vitest configuration of the web app (jsdom + React Testing Library).
 *
 * Layer: config.
 *
 * Two projects, the same split `packages/core` uses: `unit` (default `pnpm test`) excludes
 * `*.integration.test.{ts,tsx}`, and `integration` (`pnpm test:integration`) runs only those —
 * currently the Redis-backed SSE suite, which needs the compose Redis. Coverage is collected over
 * the unit project with 100 % thresholds on every path listed in `coverage.include`; each lane
 * appends its own paths, one line per lane, at the end of the list. `src/shared/ui/**` is
 * generated shadcn vendor code and is excluded (the integration wave decides whether to include
 * it).
 */
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

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
          include: ['src/**/*.test.{ts,tsx}', 'app/**/*.test.{ts,tsx}'],
          exclude: ['src/**/*.integration.test.{ts,tsx}', 'e2e/**', 'node_modules/**', '.next/**'],
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
        'src/shared/api/**',
        'src/shared/lib/**',
        'src/shared/transcript/**',
        'src/shared/feedback/**',
        'src/features/chats/**',
        'src/features/shell/**',
        'src/features/scheduled/**',
        'src/features/settings/**',
        'src/mocks/**',
        'src/shared/repo-picker/**',
        'src/shared/shell/PageHeader.tsx',
        'app/api/**',
        'src/server/**',
      ],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/index.ts',
        'src/shared/ui/**',
        'src/test/**',
        // Pure wiring, not exercised in isolation: MSW bootstraps and route composition.
        'src/mocks/browser.ts',
        'src/mocks/server.ts',
        'src/mocks/handlers.ts',
        'src/mocks/vitest.ts',
        'src/shared/repo-picker/testing/setup.ts',
        'src/features/shell/testing/**',
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
