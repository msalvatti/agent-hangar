/** @vitest-environment node */
/**
 * Integration test (@db) for `DELETE /api/chats/:id` racing `POST /api/chats/:id/messages`,
 * against a real Postgres.
 *
 * Layer: integration.
 * Goal: the one thing no repository double can settle — that "this chat carries no live turn" is
 * decided by the database inside the delete, not by this process one round trip earlier. The rival
 * message is driven from inside the workspace read, which is the step that genuinely sits between
 * the delete's read of the chat and its write, so the interleaving is the real window rather than
 * a stubbed answer or a lucky schedule. With the condition read ahead of the write, the message is
 * answered `201`, hands a turn to the worker, and the delete then cascades that very turn away.
 * Mocks: the `bullmq` module, so the dispatch records rather than needing Redis; the repositories
 * are the real Prisma ones, which is the whole point.
 */
import { createRedactor, createRepositories, disconnectPrisma } from '@agent-hangar/core';
import type { Repositories } from '@agent-hangar/core';
import { connectTestDb, describeDb, truncateAll } from '@agent-hangar/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { CREATE_BODY } from '../testing/chat-fixtures';
import { writeRequest } from '../testing/requests';
import { createTestContainer } from '../testing/test-container';
import type { TestContainer } from '../testing/test-container';

import { createChat, deleteChat, postMessage } from './chats';

vi.mock('bullmq', () => import('../testing/fake-queue'));

/** Usage totals of a turn that is finished by hand, so the chat is idle again. */
const NO_USAGE = { inputTokens: 0, outputTokens: 0, stepCount: 0 };

let client: ReturnType<typeof connectTestDb>;
let repos: Repositories;
let harness: TestContainer;

describeDb('deleteChat racing postMessage', () => {
  beforeEach(async () => {
    client = connectTestDb();
    await truncateAll(client);
    repos = createRepositories(client, createRedactor());
    harness = createTestContainer({ overrides: { repos } });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await disconnectPrisma(client);
  });

  /**
   * A message that claims the chat's work slot inside the delete's own window is either refused or
   * honoured — never honoured and then undone. The delete is the side that gives way here, because
   * the message has already been told `201` and its turn has already been handed to the worker.
   */
  it('never deletes a chat whose work slot a message claimed in the same window', async () => {
    const created = await createChat(
      harness.container,
      writeRequest('/api/chats', 'POST', CREATE_BODY),
    );
    expect(created.status).toBe(201);
    const { chatId, turnId } = (await created.json()) as { chatId: string; turnId: string };
    await repos.turns.finish(turnId, 'SUCCEEDED', NO_USAGE);

    // Collected rather than assigned to a single binding: the rival runs inside a callback, and
    // the request under test must be able to read what it answered.
    const rival: Response[] = [];
    const findLiveByChat = repos.workspaces.findLiveByChat.bind(repos.workspaces);
    vi.spyOn(repos.workspaces, 'findLiveByChat').mockImplementation(async (id: string) => {
      const live = await findLiveByChat(id);
      if (rival.length === 0) {
        rival.push(
          await postMessage(
            harness.container,
            writeRequest(`/api/chats/${id}/messages`, 'POST', { prompt: 'one more thing' }),
            { id },
          ),
        );
      }
      return live;
    });

    const deleted = await deleteChat(harness.container, writeRequest('/api/chats', 'DELETE'), {
      id: chatId,
    });

    expect(rival.map((response) => response.status)).toEqual([201]);
    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toMatchObject({ error: { code: 'TURN_IN_PROGRESS' } });
    expect(await repos.chats.getById(chatId)).not.toBeNull();
    const live = (await repos.turns.listByChat(chatId)).filter((turn) => turn.status === 'QUEUED');
    expect(live).toHaveLength(1);
  });
});
