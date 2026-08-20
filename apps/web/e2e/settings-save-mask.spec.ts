/**
 * Credentials are stored, shown only as a mask, and never echoed back in plaintext.
 *
 * Layer: end-to-end spec.
 *
 * Covers the settings flow and the promise underneath it: a credential goes in through one request
 * body and comes back only as four visible characters — not in the interface, not in an API
 * response, not in a stored tool call. The values used are the project's canaries, so a leak is
 * detectable rather than merely unlikely.
 */
import { chatDetail, settingsStatus } from '@agent-hangar/core';
import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';

import { test, expect } from './fixtures';
import { ChatPage, SettingsPage } from './pages';
import { createChatAndRun, waitForTurnStatus } from './support/chat-flows';
import { PROMPTS, TURN_TIMEOUT_MS } from './support/constants';
import { useMockScenario } from './support/mock-scenario';
import { skipUnlessReal } from './support/mode';

/** Replacement value: the canary with a different tail, so the mask visibly changes. */
const REPLACED_GITHUB_CANARY = `${GITHUB_CANARY.slice(0, -4)}ZZZZ`;

/** A mask is eight bullets followed by the last four characters of the stored value. */
const MASK_PATTERN = /^•{8}(.{4})$/u;

/**
 * Proves an unset credential accepts a value and immediately renders as a mask ending in its last
 * four characters; that the second credential behaves the same; that Replace swaps the value and
 * the mask follows; that Remove takes the field back to its input; and — with the real API behind
 * it — that a reload keeps the masks and that `GET /api/settings` carries the last four characters
 * and no plaintext.
 */
test('credentials are saved, masked, replaced and removed', async ({ page, api, mode }) => {
  await useMockScenario(page, 'missing-settings');
  const settings = new SettingsPage(page);
  await settings.goto();
  await settings.expectNotSet('GITHUB_PAT');
  await settings.expectNotSet('OPENAI_API_KEY');

  await settings.save('GITHUB_PAT', GITHUB_CANARY);
  expect(await settings.maskText('GITHUB_PAT')).toMatch(MASK_PATTERN);
  expect(await settings.maskText('GITHUB_PAT')).toContain(GITHUB_CANARY.slice(-4));

  await settings.save('OPENAI_API_KEY', OPENAI_CANARY);
  expect(await settings.maskText('OPENAI_API_KEY')).toContain(OPENAI_CANARY.slice(-4));

  assertNoCanary(await page.content());

  await settings.replace('GITHUB_PAT', REPLACED_GITHUB_CANARY);
  expect(await settings.maskText('GITHUB_PAT')).toContain('ZZZZ');

  await settings.remove('OPENAI_API_KEY');

  skipUnlessReal(test, mode, 'persistence and redaction need the API, the database and the worker');

  await settings.save('OPENAI_API_KEY', OPENAI_CANARY);
  await page.reload();
  await expect(settings.mask('GITHUB_PAT')).toBeVisible();
  await expect(settings.mask('OPENAI_API_KEY')).toBeVisible();

  // The untouched text first: parsing with the contract schema strips whatever the schema does not
  // declare, so a plaintext field nobody expected would be gone before the leak check could see
  // it. The replacement value is checked by name too — it is not one of the registered canaries,
  // so `assertNoCanary` alone would not notice it coming back.
  const raw = await api.raw('/api/settings', { method: 'GET' });
  assertNoCanary(raw.text);
  expect(raw.text).not.toContain(REPLACED_GITHUB_CANARY);
  const status = settingsStatus.parse(JSON.parse(raw.text));
  expect(status.githubPat.last4).toBe('ZZZZ');
  expect(status.openaiKey.last4).toBe(OPENAI_CANARY.slice(-4));
});

/**
 * Proves a tool call whose arguments carry the stored credential is persisted and rendered
 * redacted: the row shows the redaction marker, and neither the rendered page nor the chat
 * response contains the canary.
 */
test('a credential inside tool-call arguments is stored redacted', async ({
  page,
  api,
  mode,
  seedSettings,
}) => {
  skipUnlessReal(test, mode, 'redaction happens in the worker, on the way to the database');

  const { chatId, turnId } = await createChatAndRun(
    { page, api, mode, seedSettings },
    PROMPTS.writeToken,
  );
  await waitForTurnStatus(api, chatId, turnId ?? '', 'SUCCEEDED', TURN_TIMEOUT_MS);

  const chat = new ChatPage(page);
  const row = chat.toolRows('write_file').first();
  await expect(row).toBeVisible({ timeout: TURN_TIMEOUT_MS });
  await chat.expandToolRow(row);
  const rowText = await row.innerText();
  expect(rowText).toContain('[REDACTED]');
  assertNoCanary(rowText);
  assertNoCanary(await page.content());

  const detail = await api.get(`/api/chats/${chatId}`, chatDetail);
  assertNoCanary(JSON.stringify(detail));
  expect(detail.toolCalls.map((call) => call.toolName)).toEqual(['write_file']);
});
