/**
 * Steps every chat spec repeats: choosing a target, starting a chat, and waiting for the API to
 * agree with what the interface showed.
 *
 * Layer: test support (Playwright).
 *
 * Turn and workspace state is read through `GET /api/chats/:id`, never from the database: the
 * response is what the product promises, and a spec that read the row would keep passing after the
 * API stopped exposing it. The health endpoint carries no workspace counters today, so a
 * workspace's fate is asserted through the chat's own `workspace` field, which the contract does
 * define.
 */
import { chatDetail } from '@agent-hangar/core';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { z } from 'zod';

import { ChatPage } from '../pages/chat';
import { ComposerPage } from '../pages/composer';
import { SidebarPage } from '../pages/sidebar';

import type { E2eApi } from './api';
import { SAMPLE_BRANCH, SAMPLE_REPO } from './constants';
import type { E2eMode } from './mode';

/** Parsed `GET /api/chats/:id` body. */
export type ChatDetailView = z.infer<typeof chatDetail>;

/** Repository the mock API seeds, so the pickers have something to choose in mock mode. */
export const MOCK_REPO = 'acme/api';

/** Default branch of that repository. */
export const MOCK_BRANCH = 'main';

/** Repository and branch a chat is started against, per mode. */
export function chatTarget(mode: E2eMode): { repo: string; branch: string } {
  return mode === 'mock'
    ? { repo: MOCK_REPO, branch: MOCK_BRANCH }
    : { repo: SAMPLE_REPO, branch: SAMPLE_BRANCH };
}

/** What {@link createChatAndRun} needs from the fixtures. */
export interface ChatFlowContext {
  page: Page;
  api: E2eApi;
  mode: E2eMode;
  seedSettings: () => Promise<void>;
}

/** Identifiers of the chat a flow created. */
export interface StartedChat {
  chatId: string;
  /** Id of the turn the prompt queued, or `undefined` in mock mode, where no turn is persisted. */
  turnId: string | undefined;
}

/**
 * Stores the credentials, starts a chat from the new-chat screen and waits for its page.
 *
 * @param context - Page, API client, mode and the credential seeder.
 * @param prompt - Prompt to send; must be one the fake provider is scripted for.
 * @returns The chat id, and the turn id in real mode.
 */
export async function createChatAndRun(
  context: ChatFlowContext,
  prompt: string,
): Promise<StartedChat> {
  await context.seedSettings();
  const sidebar = new SidebarPage(context.page);
  const composer = new ComposerPage(context.page);
  const target = chatTarget(context.mode);
  await sidebar.goto();
  await composer.chooseRepo(target.repo);
  await composer.chooseBranch(target.branch);
  await composer.type(prompt);
  await composer.submit();
  await expect(context.page).toHaveURL(/\/chats\/(?!new)[^/]+$/);
  const chatId = new ChatPage(context.page).chatIdFromUrl();
  if (context.mode === 'mock') {
    return { chatId, turnId: undefined };
  }
  const detail = await context.api.get(`/api/chats/${chatId}`, chatDetail);
  const turn = detail.turns.at(-1);
  if (turn === undefined) {
    throw new Error(`Chat ${chatId} was created without a turn`);
  }
  return { chatId, turnId: turn.id };
}

/**
 * Waits for one turn to reach a status.
 *
 * @param api - API client.
 * @param chatId - Chat holding the turn.
 * @param turnId - Turn to watch.
 * @param status - Status to wait for.
 * @param timeoutMs - Budget.
 */
export async function waitForTurnStatus(
  api: E2eApi,
  chatId: string,
  turnId: string,
  status: string,
  timeoutMs: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const detail = await api.get(`/api/chats/${chatId}`, chatDetail);
        return detail.turns.find((turn) => turn.id === turnId)?.status;
      },
      { timeout: timeoutMs, message: `turn ${turnId} of chat ${chatId} never reached ${status}` },
    )
    .toBe(status);
}

/**
 * Waits for a chat's workspace to reach a status, or to be gone.
 *
 * @param api - API client.
 * @param chatId - Chat to watch.
 * @param status - Workspace status, or `null` for "no live workspace".
 * @param timeoutMs - Budget.
 */
export async function waitForWorkspace(
  api: E2eApi,
  chatId: string,
  status: string | null,
  timeoutMs: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const detail = await api.get(`/api/chats/${chatId}`, chatDetail);
        return detail.workspace?.status ?? null;
      },
      {
        timeout: timeoutMs,
        message: `workspace of chat ${chatId} never became ${String(status)}`,
      },
    )
    .toBe(status);
}

/**
 * Reads a chat once.
 *
 * @param api - API client.
 * @param chatId - Chat to read.
 * @returns The parsed detail.
 */
export async function readChat(api: E2eApi, chatId: string): Promise<ChatDetailView> {
  return api.get(`/api/chats/${chatId}`, chatDetail);
}
