/**
 * Fixtures shared by the chat route suites.
 *
 * Layer: test double.
 *
 * The chat routes are covered by two suites — the read and write paths in `chats.test.ts`, the
 * lifecycle and concurrency paths in `chats.lifecycle.test.ts` — and both need a chat that exists
 * exactly as the API writes it. Seeding through the create route rather than through the
 * repositories is what keeps the rows honest: a test that hand-built them could assert against a
 * shape no request ever produces.
 */
import { createChatResponse } from '@agent-hangar/core';
import { expect } from 'vitest';

import { createChat } from '../handlers/chats';

import { writeRequest } from './requests';
import type { TestContainer } from './test-container';

/** A repository URL the contracts and the host allow-list both accept. */
export const REPO_URL = 'https://github.com/acme/widgets';

/** Body of a valid create request. */
export const CREATE_BODY = {
  repoUrl: REPO_URL,
  baseBranch: 'main',
  prompt: 'Fix the failing tests',
};

/**
 * Creates a chat through the route, so the rows are exactly what the API writes.
 *
 * @param harness - The test container.
 * @param body - Overrides of the default create body.
 * @returns The created chat and turn ids.
 */
export async function seedChat(
  harness: TestContainer,
  body: Partial<typeof CREATE_BODY> = {},
): Promise<{ chatId: string; turnId: string }> {
  const response = await createChat(
    harness.container,
    writeRequest('/api/chats', 'POST', { ...CREATE_BODY, ...body }),
  );
  expect(response.status).toBe(201);
  return createChatResponse.parse(await response.json());
}
