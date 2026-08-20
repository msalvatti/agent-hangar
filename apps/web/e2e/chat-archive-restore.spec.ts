/**
 * Archiving a chat releases its workspace; restoring it keeps the history and starts a fresh one.
 *
 * Layer: end-to-end spec.
 *
 * Covers the second critical flow. The promise being tested is that archiving is not deletion: the
 * transcript survives, and the next message runs in a workspace built from scratch.
 */
import { RESTORATION_NOTICE_PREFIX } from '@agent-hangar/core';

import { test, expect } from './fixtures';
import { ChatPage, ComposerPage, SidebarPage } from './pages';
import { openSettledChat, readChat, waitForWorkspace } from './support/chat-flows';
import {
  API_SETTLE_TIMEOUT_MS,
  PROMPTS,
  TURN_TIMEOUT_MS,
  WORKSPACE_GONE_TIMEOUT_MS,
} from './support/constants';
import { skipUnlessReal } from './support/mode';

/** Text of the notices the workspace preparation renders, whichever stage it has reached. */
const PREPARATION_NOTICE = /Cloning|Prepared|Checking out/;

/**
 * Proves archiving hides the chat from the active list, shows the archived banner and releases the
 * workspace; and that restoring brings the chat back with its user message, assistant message and
 * both tool rows intact, after which a follow-up prompt prepares a new workspace, runs `read_file`
 * and succeeds.
 */
test('archiving releases the workspace and restoring keeps the history', async ({
  page,
  api,
  mode,
  seedSettings,
}) => {
  const { chatId } = await openSettledChat({ page, api, mode, seedSettings }, PROMPTS.createNotes);
  const chat = new ChatPage(page);
  const sidebar = new SidebarPage(page);
  const composer = new ComposerPage(page);
  const title = (await chat.title.innerText()).trim();
  if (mode === 'real') {
    // Waited for by name, not sampled. The rows arrive on the event stream while the API has
    // already reported the turn `SUCCEEDED`, so a bare count taken here can catch zero of them —
    // and a zero baseline would turn the comparison after the restore into a check that cannot
    // fail. The scripted turn calls exactly these two tools.
    await expect(chat.toolRows('list_dir')).toHaveCount(1, { timeout: TURN_TIMEOUT_MS });
    await expect(chat.toolRows('write_file')).toHaveCount(1, { timeout: TURN_TIMEOUT_MS });
  }
  const toolRowsBefore = await chat.toolRows().count();
  const userMessagesBefore = await chat.userMessages.count();

  // Archiving and restoring are user-interface steps the mock API implements, so they run in both
  // modes; only what the workspace and the next turn do needs the real stack.
  await chat.archive();
  expect(chat.chatIdFromUrl()).toBe(chatId);
  await expect(composer.textarea).toBeDisabled();
  await sidebar.openArchived();
  await expect(sidebar.archivedItem(title)).toBeVisible();
  await expect(sidebar.chatItem(title)).toHaveCount(0);
  if (mode === 'real') {
    // Checked here rather than after the restore below, which builds a new workspace: what
    // archiving promises is that the old one is released, and only this moment can show it.
    await waitForWorkspace(api, chatId, null, WORKSPACE_GONE_TIMEOUT_MS);
  }

  const noticesBefore = await chat.systemNotices.filter({ hasText: PREPARATION_NOTICE }).count();
  await chat.restore();
  // The exact opening the product writes, not a word that happens to appear in it: the notice is
  // normative (spec 02 §4, spec 04 (b)) and the model is shown the same sentence, so a spec that
  // matched anything looser would pass against a double that invented its own wording.
  await expect(chat.systemNotices.filter({ hasText: RESTORATION_NOTICE_PREFIX })).not.toHaveCount(
    0,
  );
  await expect(chat.userMessages).toHaveCount(userMessagesBefore);
  await expect(chat.assistantMessages).not.toHaveCount(0);
  if (mode === 'real') {
    // The record is asserted before the rendering, and separately from it, because the two fail
    // for different reasons and only one of them is about archiving: rows the archive destroyed
    // and rows the transcript declines to draw look identical from the page alone.
    const kept = await readChat(api, chatId);
    expect(kept.toolCalls.map((call) => call.toolName)).toEqual(['list_dir', 'write_file']);
  }
  await expect(chat.toolRows()).toHaveCount(toolRowsBefore);
  await expect(sidebar.chatItem(title)).toBeVisible();

  skipUnlessReal(test, mode, 'only the worker runs the turn a restored chat starts');

  await composer.type(PROMPTS.showNotes);
  await composer.submit();
  // Strictly more preparation notices than before, not merely a different number: a notice
  // disappearing would satisfy "different" while proving the opposite of what this asserts.
  await expect
    .poll(async () => chat.systemNotices.filter({ hasText: PREPARATION_NOTICE }).count(), {
      timeout: TURN_TIMEOUT_MS,
      message: 'the follow-up message never produced a new preparation notice',
    })
    .toBeGreaterThan(noticesBefore);
  await expect(chat.toolRows('read_file')).toHaveCount(1, { timeout: TURN_TIMEOUT_MS });
  await chat.waitForText('Here is NOTES.md.', TURN_TIMEOUT_MS);
  await chat.waitForStatus('done', TURN_TIMEOUT_MS);

  const detail = await readChat(api, chatId);
  const lastTurn = detail.turns.at(-1);
  expect(lastTurn?.status).toBe('SUCCEEDED');
  await waitForWorkspace(api, chatId, 'READY', API_SETTLE_TIMEOUT_MS);
});
