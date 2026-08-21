/** @vitest-environment node */
/**
 * Integration test (@db) for what `DELETE /api/chats/:id` leaves the worker to tear down, against
 * a real Postgres.
 *
 * Layer: integration.
 * Goal: the delete hands the teardown an identifier that still reaches the workspace after the
 * chat is gone. `Workspace.chatId` is `SetNull` on the chat's cascade, so the delete clears the
 * only reference a chat-scoped job could have used — which no double can show, because the nulling
 * is the database's doing and an in-memory repository has to be told to imitate it. Measured
 * before this test existed: the row survived the delete reading `READY`, with a runner reference
 * to a container the worker had already removed.
 * Mocks: the `bullmq` module, so the enqueue records rather than needing Redis; the repositories
 * are the real Prisma ones, which is the whole point.
 */
import {
  createRedactor,
  createRepositories,
  disconnectPrisma,
  QUEUE_NAMES,
} from '@agent-hangar/core';
import type { DestroyChatWorkspacePayload, Repositories } from '@agent-hangar/core';
import { connectTestDb, describeDb, truncateAll } from '@agent-hangar/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { CREATE_BODY } from '../testing/chat-fixtures';
import { fakeQueue, resetFakeQueues } from '../testing/fake-queue';
import { writeRequest } from '../testing/requests';
import { createTestContainer } from '../testing/test-container';
import type { TestContainer } from '../testing/test-container';

import { createChat, deleteChat } from './chats';

vi.mock('bullmq', () => import('../testing/fake-queue'));

/** Usage totals of a turn that is finished by hand, so the chat is idle and deletable. */
const NO_USAGE = { inputTokens: 0, outputTokens: 0, stepCount: 0 };

let client: ReturnType<typeof connectTestDb>;
let repos: Repositories;
let harness: TestContainer;

describeDb('deleteChat handing over its workspace', () => {
  beforeEach(async () => {
    resetFakeQueues();
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
   * The teardown job names the workspace. Naming only the chat would be naming something the same
   * request has just deleted: Postgres nulls `Workspace.chatId` as the chat goes, so the consumer
   * would look up a live workspace of that chat, find none, and leave the row claiming to be live.
   * The assertion on the nulled column is here rather than implied, because it is the reason the
   * workspace id has to be on the payload at all.
   */
  it('names the workspace on the teardown job, which the chat id no longer can', async () => {
    const created = await createChat(
      harness.container,
      writeRequest('/api/chats', 'POST', CREATE_BODY),
    );
    const { chatId, turnId } = (await created.json()) as { chatId: string; turnId: string };
    await repos.turns.finish(turnId, 'SUCCEEDED', NO_USAGE);
    const workspace = await repos.workspaces.create({
      kind: 'CHAT',
      chatId,
      runnerKind: 'docker',
      image: 'agent-hangar/workspace:dev',
      repoUrl: CREATE_BODY.repoUrl,
      branch: CREATE_BODY.baseBranch,
    });
    await repos.workspaces.setStatus(workspace.id, 'READY', { runnerRef: 'container-ref' });

    const response = await deleteChat(
      harness.container,
      writeRequest(`/api/chats/${chatId}`, 'DELETE'),
      { id: chatId },
    );

    expect(response.status).toBe(204);
    expect((await repos.workspaces.get(workspace.id))?.chatId).toBeNull();
    const [job] = fakeQueue(QUEUE_NAMES.workspaceGc).added;
    expect(job?.data as DestroyChatWorkspacePayload).toEqual({
      chatId,
      workspaceId: workspace.id,
    });
  });
});
