/**
 * A new chat runs a scripted task and streams its transcript.
 *
 * Layer: end-to-end spec.
 *
 * Covers the first critical flow: choose a repository and a branch, send a prompt, watch the
 * workspace be prepared, the tools run and the answer arrive, and confirm the API agrees. In mock
 * mode the whole interface path runs and the assertions that need a worker, Docker and the git
 * server are skipped with their reason named.
 */
import { test, expect } from './fixtures';
import { ChatPage, ComposerPage, SidebarPage } from './pages';
import {
  chatTarget,
  createChatAndRun,
  readChat,
  waitForTurnStatus,
  waitForWorkspace,
} from './support/chat-flows';
import { API_SETTLE_TIMEOUT_MS, PROMPTS, TURN_TIMEOUT_MS } from './support/constants';
import { skipUnlessReal } from './support/mode';

/**
 * Proves a chat started from the new-chat screen prepares a workspace, runs the two scripted tool
 * calls in order, streams the final answer, ends `Done`, and that `GET /api/chats/:id` reports the
 * turn `SUCCEEDED` with both tool calls persisted and the workspace still ready for a follow-up.
 */
test('a new chat runs the scripted task and streams the transcript', async ({
  page,
  api,
  mode,
  seedSettings,
}) => {
  const { chatId, turnId } = await createChatAndRun(
    { page, api, mode, seedSettings },
    PROMPTS.createNotes,
  );
  const chat = new ChatPage(page);
  await expect(chat.userMessages.last()).toContainText(PROMPTS.createNotes);
  await expect(chat.transcript).toBeVisible();

  skipUnlessReal(test, mode, 'the worker, Docker and the local git server run the turn');

  await chat.expectPreparingNotice(TURN_TIMEOUT_MS);
  await expect(chat.toolRows('list_dir')).toHaveCount(1, { timeout: TURN_TIMEOUT_MS });
  await expect(chat.toolRows('write_file')).toHaveCount(1, { timeout: TURN_TIMEOUT_MS });
  await chat.waitForText('NOTES.md with the file list', TURN_TIMEOUT_MS);
  await chat.waitForStatus('done', TURN_TIMEOUT_MS);

  await waitForTurnStatus(api, chatId, turnId ?? '', 'SUCCEEDED', API_SETTLE_TIMEOUT_MS);
  const detail = await readChat(api, chatId);
  expect(detail.toolCalls.map((call) => call.toolName)).toEqual(['list_dir', 'write_file']);
  await waitForWorkspace(api, chatId, 'READY', API_SETTLE_TIMEOUT_MS);

  const writeRow = chat.toolRows('write_file').first();
  await chat.expandToolRow(writeRow);
  await expect(writeRow).toContainText('NOTES.md');
});

/**
 * Proves Send stays refused until a repository, a branch and a prompt are all present — the guard
 * that keeps a chat from being created against nothing. Pure interface behaviour, so it runs in
 * both modes.
 */
test('send stays disabled until a repository, a branch and a prompt are set', async ({
  page,
  mode,
}) => {
  const sidebar = new SidebarPage(page);
  const composer = new ComposerPage(page);
  const target = chatTarget(mode);
  await sidebar.goto();

  await composer.expectSendDisabled();
  await composer.type(PROMPTS.createNotes);
  await composer.expectSendDisabled();

  await composer.chooseRepo(target.repo);
  await composer.chooseBranch(target.branch);
  await expect(composer.send).toBeEnabled();

  await composer.type('');
  await composer.expectSendDisabled();
});
