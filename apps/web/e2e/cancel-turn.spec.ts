/**
 * Stopping a running turn cancels it promptly and keeps the workspace.
 *
 * Layer: end-to-end spec.
 *
 * Covers the cancellation flow. Two promises are at stake: the cancellation is quick — the budget
 * is a product promise, not a convenience — and it costs nothing, so the workspace survives and
 * the composer unlocks for the next message.
 */
import { test, expect } from './fixtures';
import { ChatPage, ComposerPage } from './pages';
import { createChatAndRun, waitForTurnStatus, waitForWorkspace } from './support/chat-flows';
import {
  API_SETTLE_TIMEOUT_MS,
  CANCEL_TIMEOUT_MS,
  PROMPTS,
  TURN_TIMEOUT_MS,
} from './support/constants';
import { skipUnlessReal } from './support/mode';

/** Slack the cancellation budget is measured with, covering the round trip of the last poll. */
const CANCEL_MEASUREMENT_SLACK_MS = 1_000;

/**
 * Proves that stopping a turn whose shell command is still running takes the turn to `Cancelled`
 * in the interface and to `CANCELLED` in the API inside the cancellation budget, leaves the
 * workspace ready, and unlocks the composer.
 */
test('stopping a running turn cancels it and keeps the workspace', async ({
  page,
  api,
  mode,
  seedSettings,
}) => {
  const { chatId, turnId } = await createChatAndRun(
    { page, api, mode, seedSettings },
    PROMPTS.sleepLong,
  );
  const chat = new ChatPage(page);
  const composer = new ComposerPage(page);
  await expect(chat.stop).toBeVisible();

  skipUnlessReal(test, mode, 'only the worker runs a tool long enough to be cancelled');

  const runningRow = chat.toolRows('run_shell').first();
  await expect(runningRow).toHaveAttribute('data-tool-status', 'running', {
    timeout: TURN_TIMEOUT_MS,
  });

  const requestedAt = Date.now();
  await chat.requestStop();
  await chat.waitForStatus('cancelled', CANCEL_TIMEOUT_MS);
  await waitForTurnStatus(api, chatId, turnId ?? '', 'CANCELLED', CANCEL_TIMEOUT_MS);
  expect(Date.now() - requestedAt).toBeLessThan(CANCEL_TIMEOUT_MS + CANCEL_MEASUREMENT_SLACK_MS);

  await expect(runningRow).not.toHaveAttribute('data-tool-status', 'running');
  await waitForWorkspace(api, chatId, 'READY', API_SETTLE_TIMEOUT_MS);

  await composer.type(PROMPTS.printDate);
  await expect(composer.send).toBeEnabled();
});
