/**
 * Harness boot check: the suite can reach the application and render its entry screen.
 *
 * Layer: end-to-end spec.
 *
 * Runs in both modes. If this fails, nothing downstream is worth reading: the managed servers, the
 * base URL or the mock bootstrap is broken rather than the behaviour a later spec is about.
 */
import { test, expect } from './fixtures';
import { COPY } from './support/selectors';

/**
 * Proves the application boots and serves the new-chat screen at the resolved base URL, with the
 * mock bootstrap (when in mock mode) finished rather than merely started.
 */
test('the new chat screen renders at the base URL', async ({ page }) => {
  await page.goto('/chats/new');
  await expect(page.getByRole('heading', { level: 1, name: COPY.newChatHeadline })).toBeVisible();
});
