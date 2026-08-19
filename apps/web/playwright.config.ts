/**
 * Playwright configuration of the web app.
 *
 * Layer: config.
 *
 * No `webServer` yet: the E2E harness (fixtures, local git server, DB reset) is added by the E2E
 * lane; until then the suite passes with zero specs. Locally two workers keep the machine
 * responsive while several test suites run concurrently.
 */
import { defineConfig, devices } from '@playwright/test';

const isCi = process.env.CI !== undefined;
const webPort = process.env.WEB_PORT ?? '3000';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  workers: isCi ? 1 : 2,
  reporter: isCi ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
