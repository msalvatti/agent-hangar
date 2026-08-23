/**
 * Vitest configuration used only by mutation testing.
 *
 * Layer: config.
 *
 * Stryker runs one flat project rather than the two of `vitest.config.ts`: the `integration`
 * project needs the compose Redis, which no mutant may depend on, and the end-to-end support
 * modules under `e2e/` are exercised by Playwright rather than by anything mutated here. Coverage
 * is off — Stryker measures which tests cover which mutant itself, and collecting v8 coverage on
 * top of that only slows every run.
 */
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@/app': fileURLToPath(new URL('./app', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost:3000' } },
    globals: false,
    setupFiles: [
      './src/test/setup.ts',
      './src/mocks/vitest.ts',
      './src/shared/repo-picker/testing/setup.ts',
    ],
    include: ['src/**/*.test.{ts,tsx}', 'app/**/*.test.{ts,tsx}'],
    exclude: ['src/**/*.integration.test.{ts,tsx}', 'node_modules/**', '.next/**'],
    maxWorkers: 3,
    coverage: { enabled: false },
  },
});
