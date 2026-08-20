/**
 * Playwright configuration of the web app.
 *
 * Layer: config.
 *
 * The suite runs in one of two modes, selected by `E2E_MODE`. In `mock` a production build of the
 * web app runs against the in-browser mock API, so every selector, page object and interface step
 * is exercised with no database, Redis, worker or Docker; assertions that need the real stack skip
 * with their reason named. In `real` the dev server and the worker both run against the `test`
 * instance.
 *
 * One worker and no parallelism: there is a single stack behind the suite, and specs reset it
 * between tests.
 *
 * `webServer` entries are launched BEFORE `globalSetup`, so everything they read at boot is
 * brought up earlier still, by `e2e/support/prepare-stack.ts` — the first half of the `test:e2e`
 * script. That is also where the mock-mode production build happens: the mock API cannot boot
 * under `next dev`, because React strict mode invokes its boot effect twice and the second
 * `worker.start()` is rejected.
 */
import { defineConfig, devices } from '@playwright/test';

import { resolveE2eEnv, serverEnv, webRoot } from './e2e/support/env';
import type { E2eEnv } from './e2e/support/env';

const e2e = resolveE2eEnv();
const isCi = process.env.CI !== undefined;

/** Budget for a whole test in each mode: a real turn clones a repository and runs tools. */
const TEST_TIMEOUT_MS = e2e.mode === 'real' ? 120_000 : 30_000;

/** Budget for a single `expect`. */
const EXPECT_TIMEOUT_MS = 10_000;

/** Budget for `next dev` to compile and answer. */
const WEB_BOOT_TIMEOUT_MS = 180_000;

/**
 * The web server Playwright manages when `E2E_MANAGED_SERVER=1`; otherwise the developer is
 * running it and Playwright only connects.
 *
 * The worker is not listed here on purpose — see `e2e/support/worker.ts`. It owns no port, a
 * `webServer` entry can only wait on an HTTP status, and an entry pointed at the web server's own
 * health route is considered already running and never starts anything.
 */
function managedServers(env: E2eEnv) {
  const start = env.mode === 'mock' ? 'start' : 'dev';
  const web = {
    command: `pnpm exec next ${start} -H 127.0.0.1 --port ${String(env.webPort)}`,
    cwd: webRoot(),
    env: serverEnv(env),
    reuseExistingServer: !isCi,
    timeout: WEB_BOOT_TIMEOUT_MS,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
  };
  if (env.mode === 'mock') {
    return [{ ...web, url: `${env.baseURL}/chats/new` }];
  }
  return [{ ...web, url: `${env.baseURL}/api/health` }];
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCi,
  timeout: TEST_TIMEOUT_MS,
  expect: { timeout: EXPECT_TIMEOUT_MS },
  retries: isCi ? 1 : 0,
  reporter: isCi ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: e2e.baseURL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  ...(process.env.E2E_MANAGED_SERVER === '1' ? { webServer: managedServers(e2e) } : {}),
});
