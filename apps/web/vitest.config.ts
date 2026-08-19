/**
 * Vitest configuration of the web app (jsdom + React Testing Library).
 *
 * Layer: config.
 *
 * Coverage is always on with 100 % thresholds over `coverage.include`; lanes append their own
 * paths one line at a time. `src/shared/ui/**` is generated shadcn vendor code and is excluded
 * (the integration wave decides whether to include it).
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
    name: 'web',
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'app/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    maxWorkers: 3,
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
      ],
      exclude: ['**/*.test.{ts,tsx}', '**/index.ts', 'src/shared/ui/**', 'src/test/**'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
