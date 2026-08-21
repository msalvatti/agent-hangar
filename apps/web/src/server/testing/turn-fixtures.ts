/**
 * Fixtures shared by the two turn-route suites.
 *
 * Layer: test double.
 *
 * Cancelling and retrying act on the same rows and seed them the same way, and both suites are
 * long enough to live apart, so the seeding lives here rather than being written twice. Seeding
 * through `POST /api/chats` rather than through the repositories is what keeps the rows honest: a
 * test that hand-built them could assert against a shape no request ever produces.
 */
import { expect } from 'vitest';

import { createChat } from '../handlers/chats';

import type { FakeJobState } from './fake-queue';
import type { TestContainer } from './test-container';

/** A repository URL the contracts accept. */
export const REPO_URL = 'https://github.com/acme/widgets';

/**
 * Builds a same-origin cancel request.
 *
 * @param id - Turn id.
 * @returns The request.
 */
export function cancelRequest(id: string): Request {
  return new Request(`http://127.0.0.1:3000/api/turns/${id}/cancel`, {
    method: 'POST',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
  });
}

/** The prompt every seeded chat is started with; the only one its history should ever hold. */
export const PROMPT = 'work';

/**
 * Builds a same-origin retry request.
 *
 * @param id - Turn id.
 * @returns The request.
 */
export function retryRequest(id: string): Request {
  return new Request(`http://127.0.0.1:3000/api/turns/${id}/retry`, {
    method: 'POST',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
  });
}

/**
 * Creates a chat with a queued turn through the API.
 *
 * @param harness - The test container.
 * @returns The chat id and the turn id.
 */
export async function seedChatTurn(
  harness: TestContainer,
): Promise<{ chatId: string; turnId: string }> {
  const request = new Request('http://127.0.0.1:3000/api/chats', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ repoUrl: REPO_URL, baseBranch: 'main', prompt: PROMPT }),
  });
  const response = await createChat(harness.container, request);
  return (await response.json()) as { chatId: string; turnId: string };
}

/**
 * Creates a chat with a queued turn through the API.
 *
 * @param harness - The test container.
 * @returns The turn id.
 */
export async function seedTurn(harness: TestContainer): Promise<string> {
  return (await seedChatTurn(harness)).turnId;
}

/**
 * Creates a chat whose only turn has failed, in the state the worker actually leaves behind.
 *
 * The queue job is put into a terminal state rather than dropped, because that is the precondition
 * the retry has to cope with: retention keeps the finished job holding the turn's id, and BullMQ
 * answers the next `add` for that id by returning the held job instead of enqueuing work. A turn
 * that failed while its job is still `waiting` does not occur.
 *
 * `completed` is the ordinary case — the processor only throws for a transport error, so an OpenAI
 * or workspace failure is recorded on the turn while the job itself completes.
 *
 * @param harness - The test container.
 * @param jobState - Terminal state the consumed job is left in.
 * @returns The chat id and the failed turn id.
 */
export async function seedFailedTurn(
  harness: TestContainer,
  jobState: FakeJobState = 'completed',
): Promise<{ chatId: string; turnId: string }> {
  const seeded = await seedChatTurn(harness);
  await harness.doubles.repos.turns.setStatus(seeded.turnId, 'PREPARING');
  await harness.doubles.repos.turns.finish(
    seeded.turnId,
    'FAILED',
    { inputTokens: 11, outputTokens: 7, stepCount: 2 },
    'OpenAI rejected the request',
  );
  // Every job the queue holds, rather than a lookup by id and a guard for a miss that cannot
  // happen: the seed enqueued exactly one, which the assertion states, and a fixture has no
  // business carrying a branch no test can reach.
  const { chatTurns } = harness.doubles.queues;
  expect(chatTurns.jobs.size).toBe(1);
  for (const job of chatTurns.jobs.values()) {
    job.state = jobState;
  }
  chatTurns.added.length = 0;
  return seeded;
}

/**
 * Reads back what the chat actually persisted for the user.
 *
 * @param harness - The test container.
 * @param chatId - Chat to read.
 * @returns The content of every persisted USER message, in order.
 */
export async function userPrompts(harness: TestContainer, chatId: string): Promise<string[]> {
  const messages = await harness.doubles.repos.messages.listByChat(chatId);
  return messages.filter((message) => message.role === 'USER').map((message) => message.content);
}
