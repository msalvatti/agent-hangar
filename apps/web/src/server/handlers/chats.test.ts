/** @vitest-environment node */
/**
 * Unit tests for the chat routes.
 *
 * Layer: unit.
 * Goal: every row a handler writes, every guard it enforces and every job it enqueues, against the
 * in-memory repositories and the BullMQ double — including the orderings that matter when a step
 * fails halfway.
 * Mocks: the `bullmq` module; everything else is a real core double.
 */
import {
  chatDetail,
  chatSummary,
  createChatResponse,
  JOB_NAMES,
  listChatsResponse,
  postMessageResponse,
  RESTORATION_NOTICE_PREFIX,
} from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import { foreignRequest, readRequest, writeRequest } from '../testing/requests';
import { createTestContainer } from '../testing/test-container';
import type { TestContainer } from '../testing/test-container';

import {
  archiveChat,
  createChat,
  deleteChat,
  getChat,
  listChats,
  postMessage,
  renameChat,
  restoreChat,
  TITLE_LENGTH,
  titleFromPrompt,
} from './chats';

vi.mock('bullmq', () => import('../testing/fake-queue'));

/** A repository URL the contracts and the host allow-list both accept. */
const REPO_URL = 'https://github.com/acme/widgets';

/** Body of a valid create request. */
const CREATE_BODY = { repoUrl: REPO_URL, baseBranch: 'main', prompt: 'Fix the failing tests' };

/**
 * Creates a chat through the route, so the rows are exactly what the API writes.
 *
 * @param harness - The test container.
 * @param body - Overrides of the default create body.
 * @returns The created chat and turn ids.
 */
async function seedChat(
  harness: TestContainer,
  body: Partial<typeof CREATE_BODY> = {},
): Promise<{ chatId: string; turnId: string }> {
  const response = await createChat(
    harness.container,
    writeRequest('/api/chats', 'POST', {
      ...CREATE_BODY,
      ...body,
    }),
  );
  expect(response.status).toBe(201);
  return createChatResponse.parse(await response.json());
}

describe('titleFromPrompt', () => {
  /**
   * The title is the prompt's first line of text, collapsed and cut: the sidebar has one row per
   * chat, and a pasted stack trace would otherwise become the label.
   */
  it('collapses whitespace and caps the length', () => {
    expect(titleFromPrompt('  fix   the\n tests ')).toBe('fix the tests');
    expect(titleFromPrompt('x'.repeat(200))).toHaveLength(TITLE_LENGTH);
  });
});

describe('createChat', () => {
  /**
   * The happy path writes the three rows the flow depends on and hands the turn to the worker with
   * the turn id as the job id, which is what makes a retried request enqueue once.
   */
  it('creates the chat, the first message and a queued turn, then enqueues it', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);

    const chat = await harness.doubles.repos.chats.getById(chatId);
    expect(chat).toMatchObject({
      title: 'Fix the failing tests',
      status: 'ACTIVE',
      repoUrl: REPO_URL,
    });
    const messages = await harness.doubles.repos.messages.listByChat(chatId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'USER', seq: 1, content: CREATE_BODY.prompt });
    const turn = await harness.doubles.repos.turns.get(turnId);
    expect(turn).toMatchObject({ status: 'QUEUED', queueJobId: turnId });
    expect(harness.doubles.queues.chatTurns.added).toEqual([
      {
        name: JOB_NAMES.runTurn,
        data: { turnId },
        opts: expect.objectContaining({ jobId: turnId }) as unknown,
      },
    ]);
  });

  /**
   * A body the contract rejects never reaches a repository, and the message names the field so the
   * form can point at it.
   */
  it('rejects an invalid body and an unparseable one', async () => {
    const { container, doubles } = createTestContainer();
    const invalid = await createChat(
      container,
      writeRequest('/api/chats', 'POST', { repoUrl: REPO_URL }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const broken = new Request('http://127.0.0.1:3000/api/chats', {
      method: 'POST',
      headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
      body: '{',
    });
    expect((await createChat(container, broken)).status).toBe(400);
    expect(await doubles.repos.chats.list()).toHaveLength(0);
  });

  /**
   * A repository on a host the operator did not allow is refused before any row exists; the URL
   * ends up on a clone command line inside a container, so the check belongs at the boundary.
   */
  it('rejects a repository host that is not allowed', async () => {
    const { container, doubles } = createTestContainer({
      overrides: {},
    });
    const response = await createChat(
      container,
      writeRequest('/api/chats', 'POST', { ...CREATE_BODY, repoUrl: 'https://github.com/a/b/c' }),
    );
    expect(response.status).toBe(400);
    expect(await doubles.repos.chats.list()).toHaveLength(0);
  });

  /**
   * Without both credentials the turn could not run, so nothing is written at all: a chat whose
   * first turn is doomed is worse than a clear refusal.
   */
  it('refuses to create anything while a credential is missing', async () => {
    const { container, doubles } = createTestContainer({ secretsSet: false });
    const response = await createChat(container, writeRequest('/api/chats', 'POST', CREATE_BODY));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'SECRETS_MISSING' } });
    expect(await doubles.repos.chats.list()).toHaveLength(0);
  });

  /**
   * When the enqueue fails the turn is closed as `FAILED` rather than left `QUEUED`: a queued turn
   * no worker will ever see would spin the UI forever.
   */
  it('fails the turn when the queue rejects the job', async () => {
    const harness = createTestContainer();
    harness.doubles.queues.chatTurns.addFailure = new Error('redis unreachable');
    const response = await createChat(
      harness.container,
      writeRequest('/api/chats', 'POST', CREATE_BODY),
    );
    expect(response.status).toBe(500);
    const [chat] = await harness.doubles.repos.chats.list();
    const turns = await harness.doubles.repos.turns.listByChat(chat!.id);
    expect(turns[0]).toMatchObject({ status: 'FAILED', error: 'Could not enqueue the turn' });
  });

  /**
   * The guard on state-changing routes: a foreign origin never reaches the body, so a page open in
   * another tab cannot create work in this instance.
   */
  it('rejects a cross-origin create', async () => {
    const { container, doubles } = createTestContainer();
    const response = await createChat(container, foreignRequest('/api/chats', 'POST', CREATE_BODY));
    expect(response.status).toBe(403);
    expect(await doubles.repos.chats.list()).toHaveLength(0);
  });
});

describe('listChats', () => {
  /**
   * The list carries the status of the most recent turn, which is the sidebar's activity dot, and
   * an unfiltered request returns archived chats too.
   */
  it('lists chats with their last turn status and filters by status', async () => {
    const harness = createTestContainer();
    const first = await seedChat(harness);
    const second = await seedChat(harness, { prompt: 'Second task' });
    await harness.doubles.repos.turns.finish(second.turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    const archived = await archiveChat(harness.container, writeRequest('/api/chats', 'POST'), {
      id: second.chatId,
    });
    expect(archived.status).toBe(200);

    const all = listChatsResponse.parse(
      await (await listChats(harness.container, readRequest('/api/chats'))).json(),
    );
    expect(all.chats).toHaveLength(2);
    expect(all.chats.map((chat) => chat.id)).toContain(first.chatId);
    expect(all.chats.find((chat) => chat.id === first.chatId)?.lastTurnStatus).toBe('QUEUED');

    const active = listChatsResponse.parse(
      await (await listChats(harness.container, readRequest('/api/chats?status=ACTIVE'))).json(),
    );
    expect(active.chats.map((chat) => chat.id)).toEqual([first.chatId]);
  });

  /**
   * A chat that has no turn yet — the worker deleted its only one, or a row was seeded directly —
   * reports no activity rather than failing to serialise.
   */
  it('reports no last turn status for a chat with no turns', async () => {
    const harness = createTestContainer();
    await harness.doubles.repos.chats.create({
      title: 'Seeded',
      repoUrl: REPO_URL,
      baseBranch: 'main',
    });
    const body = listChatsResponse.parse(
      await (await listChats(harness.container, readRequest('/api/chats'))).json(),
    );
    expect(body.chats[0]?.lastTurnStatus).toBeNull();
  });

  /**
   * A status the contract does not know is refused rather than ignored: silently returning every
   * chat would look like a bug in the sidebar.
   */
  it('rejects an unknown status filter', async () => {
    const { container } = createTestContainer();
    const response = await listChats(container, readRequest('/api/chats?status=ALL'));
    expect(response.status).toBe(400);
  });
});

describe('getChat', () => {
  /**
   * The detail response satisfies its contract in full, including the empty tool-call list and the
   * absent workspace of a chat whose turn has not started.
   */
  it('returns the chat with its history', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    const detail = chatDetail.parse(
      await (
        await getChat(harness.container, readRequest(`/api/chats/${chatId}`), { id: chatId })
      ).json(),
    );
    expect(detail.chat.id).toBe(chatId);
    expect(detail.messages.map((message) => message.seq)).toEqual([1]);
    expect(detail.turns.map((turn) => turn.id)).toEqual([turnId]);
    expect(detail.toolCalls).toEqual([]);
    expect(detail.workspace).toBeNull();
  });

  /**
   * Tool calls are returned in execution order across the whole chat, because the transcript
   * renders them interleaved with the messages rather than grouped by turn.
   */
  it('returns tool calls ordered by their sequence', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    const workspace = await harness.doubles.repos.workspaces.create({
      kind: 'CHAT',
      chatId,
      runnerKind: 'docker',
      image: 'agent-hangar/workspace:dev',
      repoUrl: REPO_URL,
      branch: 'main',
    });
    for (const seq of [2, 1]) {
      await harness.doubles.repos.toolCalls.start({
        workspaceId: workspace.id,
        turnId,
        callId: `call-${String(seq)}`,
        seq,
        toolName: 'run_shell',
        args: { command: 'ls' },
      });
    }
    const detail = chatDetail.parse(
      await (
        await getChat(harness.container, readRequest(`/api/chats/${chatId}`), { id: chatId })
      ).json(),
    );
    expect(detail.toolCalls.map((call) => call.seq)).toEqual([1, 2]);
    expect(detail.workspace?.id).toBe(workspace.id);
  });

  /**
   * An unknown id is a missing resource, not a server fault.
   */
  it('reports an unknown chat as missing', async () => {
    const { container } = createTestContainer();
    const response = await getChat(container, readRequest('/api/chats/nope'), { id: 'nope' });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('renameChat', () => {
  /**
   * Renaming trims the title and answers with the updated summary, which is what the header
   * renders after an inline edit.
   */
  it('renames the chat', async () => {
    const harness = createTestContainer();
    const { chatId } = await seedChat(harness);
    const response = await renameChat(
      harness.container,
      writeRequest(`/api/chats/${chatId}`, 'PATCH', { title: '  Renamed  ' }),
      { id: chatId },
    );
    expect(chatSummary.parse(await response.json()).title).toBe('Renamed');
  });

  /**
   * An empty title is refused: the sidebar row would have nothing to show.
   */
  it('rejects an empty title and an unknown chat', async () => {
    const harness = createTestContainer();
    const { chatId } = await seedChat(harness);
    const empty = await renameChat(
      harness.container,
      writeRequest(`/api/chats/${chatId}`, 'PATCH', { title: '   ' }),
      { id: chatId },
    );
    expect(empty.status).toBe(400);
    const missing = await renameChat(
      harness.container,
      writeRequest('/api/chats/nope', 'PATCH', { title: 'x' }),
      { id: 'nope' },
    );
    expect(missing.status).toBe(404);
  });
});

describe('postMessage', () => {
  /**
   * A follow-up message continues the sequence and queues a second turn once the first one has
   * finished.
   */
  it('appends the message and queues the next turn', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 1,
      outputTokens: 1,
      stepCount: 1,
    });

    const response = await postMessage(
      harness.container,
      writeRequest(`/api/chats/${chatId}/messages`, 'POST', { prompt: 'And now the docs' }),
      { id: chatId },
    );
    expect(response.status).toBe(201);
    const { turnId: nextTurn } = postMessageResponse.parse(await response.json());
    const messages = await harness.doubles.repos.messages.listByChat(chatId);
    expect(messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(nextTurn).not.toBe(turnId);
    expect(harness.doubles.queues.chatTurns.added).toHaveLength(2);
  });

  /**
   * An archived chat has no workspace and no restore notice yet, so a message would silently start
   * work the user did not ask for; the UI offers Restore instead.
   */
  it('refuses a message on an archived chat', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    await archiveChat(harness.container, writeRequest('/api/chats', 'POST'), { id: chatId });
    const response = await postMessage(
      harness.container,
      writeRequest(`/api/chats/${chatId}/messages`, 'POST', { prompt: 'hello' }),
      { id: chatId },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'CHAT_ARCHIVED' } });
  });

  /**
   * A second turn under a live one would race the worker for the same container, so it is refused
   * while the first is queued or executing.
   */
  it('refuses a message while a turn is live', async () => {
    const harness = createTestContainer();
    const { chatId } = await seedChat(harness);
    const response = await postMessage(
      harness.container,
      writeRequest(`/api/chats/${chatId}/messages`, 'POST', { prompt: 'hello' }),
      { id: chatId },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TURN_IN_PROGRESS' } });
  });

  /**
   * The credential guard applies to every route that starts work, not only to chat creation.
   */
  it('refuses a message while a credential is missing', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    await harness.doubles.secrets.remove('OPENAI_API_KEY');
    const response = await postMessage(
      harness.container,
      writeRequest(`/api/chats/${chatId}/messages`, 'POST', { prompt: 'hello' }),
      { id: chatId },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'SECRETS_MISSING' } });
  });

  /**
   * An unknown chat is reported before anything else is checked.
   */
  it('reports an unknown chat as missing', async () => {
    const { container } = createTestContainer();
    const response = await postMessage(
      container,
      writeRequest('/api/chats/nope/messages', 'POST', { prompt: 'hi' }),
      { id: 'nope' },
    );
    expect(response.status).toBe(404);
  });
});

describe('archiveChat and restoreChat', () => {
  /**
   * Archiving flips the status, stamps `archivedAt` and asks the worker to tear the container
   * down; the job is enqueued unconditionally because only the worker knows whether one exists.
   */
  it('archives the chat and enqueues the teardown', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    const response = await archiveChat(harness.container, writeRequest('/api/chats', 'POST'), {
      id: chatId,
    });
    const summary = chatSummary.parse(await response.json());
    expect(summary.status).toBe('ARCHIVED');
    expect(summary.archivedAt).not.toBeNull();
    expect(harness.doubles.queues.workspaceGc.added).toEqual([
      {
        name: JOB_NAMES.destroyChatWorkspace,
        data: { chatId },
        opts: expect.objectContaining({ jobId: `destroy-${chatId}` }) as unknown,
      },
    ]);
  });

  /**
   * Archiving an archived chat is an illegal transition, and archiving one whose turn is running
   * would tear the container out from under the worker.
   */
  it('refuses to archive twice or while a turn is live', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    const busy = await archiveChat(harness.container, writeRequest('/api/chats', 'POST'), {
      id: chatId,
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: 'TURN_IN_PROGRESS' } });

    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    await archiveChat(harness.container, writeRequest('/api/chats', 'POST'), { id: chatId });
    const again = await archiveChat(harness.container, writeRequest('/api/chats', 'POST'), {
      id: chatId,
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'ILLEGAL_TRANSITION' } });
  });

  /**
   * Restoring reactivates the chat and records a SYSTEM notice, which is the only thing that tells
   * the model its filesystem is gone; `?warm=1` is accepted and does nothing in v1.
   */
  it('restores the chat and appends the restoration notice', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    await archiveChat(harness.container, writeRequest('/api/chats', 'POST'), { id: chatId });

    const response = await restoreChat(
      harness.container,
      writeRequest(`/api/chats/${chatId}/restore?warm=1`, 'POST'),
      { id: chatId },
    );
    expect(chatSummary.parse(await response.json()).status).toBe('ACTIVE');
    const messages = await harness.doubles.repos.messages.listByChat(chatId);
    expect(messages.at(-1)).toMatchObject({ role: 'SYSTEM' });
    expect(messages.at(-1)?.content).toContain(RESTORATION_NOTICE_PREFIX);
  });

  /**
   * Restoring an active chat is an illegal transition; an unknown one is missing. Both are checked
   * before the notice is written, so a failed restore leaves no trace.
   */
  it('refuses to restore an active or unknown chat and rejects a bad query', async () => {
    const harness = createTestContainer();
    const { chatId } = await seedChat(harness);
    const active = await restoreChat(harness.container, writeRequest('/api/chats', 'POST'), {
      id: chatId,
    });
    expect(active.status).toBe(409);
    const missing = await restoreChat(harness.container, writeRequest('/api/chats', 'POST'), {
      id: 'nope',
    });
    expect(missing.status).toBe(404);
    const bad = await restoreChat(
      harness.container,
      writeRequest(`/api/chats/${chatId}/restore?warm=maybe`, 'POST'),
      { id: chatId },
    );
    expect(bad.status).toBe(400);
  });
});

describe('deleteChat', () => {
  /**
   * A delete answers 204 with no body — the shared client rejects a body here — and takes the
   * messages and turns with it.
   */
  it('deletes the chat and everything that cascades from it', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    const response = await deleteChat(harness.container, writeRequest('/api/chats', 'DELETE'), {
      id: chatId,
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(await harness.doubles.repos.chats.getById(chatId)).toBeNull();
    expect(await harness.doubles.repos.messages.listByChat(chatId)).toEqual([]);
    expect(harness.doubles.queues.workspaceGc.added).toEqual([]);
  });

  /**
   * With a live workspace the teardown job goes out before the row disappears, while the chat id
   * still resolves to one.
   */
  it('enqueues the teardown when a workspace is live', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    await harness.doubles.repos.workspaces.create({
      kind: 'CHAT',
      chatId,
      runnerKind: 'docker',
      image: 'agent-hangar/workspace:dev',
      repoUrl: REPO_URL,
      branch: 'main',
    });
    await deleteChat(harness.container, writeRequest('/api/chats', 'DELETE'), { id: chatId });
    expect(harness.doubles.queues.workspaceGc.added).toHaveLength(1);
  });

  /**
   * Deleting under a live turn would leave the worker writing rows that no longer exist.
   */
  it('refuses to delete while a turn is live, and reports an unknown chat', async () => {
    const harness = createTestContainer();
    const { chatId } = await seedChat(harness);
    const busy = await deleteChat(harness.container, writeRequest('/api/chats', 'DELETE'), {
      id: chatId,
    });
    expect(busy.status).toBe(409);
    const missing = await deleteChat(harness.container, writeRequest('/api/chats', 'DELETE'), {
      id: 'nope',
    });
    expect(missing.status).toBe(404);
  });
});
