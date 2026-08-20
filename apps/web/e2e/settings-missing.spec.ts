/**
 * Without credentials the product refuses to start a chat, and says where to fix it.
 *
 * Layer: end-to-end spec.
 *
 * Covers the last critical flow. The refusal has to happen in two places, and both are asserted:
 * the interface withholds the composer and points at the settings screen, and the API refuses the
 * request outright — so a client that skipped the interface gets the same answer.
 */
import { createChatResponse } from '@agent-hangar/core';
import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';

import { test, expect } from './fixtures';
import { ComposerPage, SettingsPage, SidebarPage } from './pages';
import { E2eApiError } from './support/api';
import { SAMPLE_BRANCH } from './support/constants';
import { useMockScenario } from './support/mock-scenario';
import { skipUnlessReal } from './support/mode';

/** Code the API answers with while a credential is missing. */
const SECRETS_MISSING = 'SECRETS_MISSING';

/** Status the API answers with while a credential is missing. */
const CONFLICT = 409;

/**
 * Proves the new-chat screen replaces its composer with the credentials notice, that the notice
 * links to the settings screen, and that storing both credentials there brings the composer back
 * without a reload.
 */
test('the new chat screen refuses to compose without credentials', async ({ page }) => {
  await useMockScenario(page, 'missing-settings');
  const sidebar = new SidebarPage(page);
  const composer = new ComposerPage(page);
  const settings = new SettingsPage(page);

  await sidebar.goto();
  await composer.expectBlockedBySecrets();

  await composer.secretsMissingLink.click();
  await expect(page).toHaveURL(/\/settings$/);
  await settings.save('GITHUB_PAT', GITHUB_CANARY);
  await settings.save('OPENAI_API_KEY', OPENAI_CANARY);

  await sidebar.openNewChat();
  await expect(composer.textarea).toBeVisible();
  await expect(composer.secretsMissingNotice).toHaveCount(0);
});

/**
 * Proves the API refuses `POST /api/chats` with `409 SECRETS_MISSING` while no credential is
 * stored, and that its refusal carries no credential material.
 *
 * The body is validated before the credentials are checked, so this only reaches the refusal it is
 * about once the request schema accepts a repository on the configured host. Until then it fails
 * on the status, naming 400 against the expected 409.
 */
test('the API refuses to create a chat without credentials', async ({ api, gitServer, mode }) => {
  skipUnlessReal(test, mode, 'the mock build serves no API routes');

  const failure = await api
    .post(
      '/api/chats',
      { repoUrl: gitServer.repoUrl, baseBranch: SAMPLE_BRANCH, prompt: 'anything' },
      createChatResponse,
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  expect(failure).toBeInstanceOf(E2eApiError);
  const apiFailure = failure as E2eApiError;
  expect(apiFailure.status).toBe(CONFLICT);
  expect(apiFailure.code).toBe(SECRETS_MISSING);
  assertNoCanary(apiFailure.message);
});
