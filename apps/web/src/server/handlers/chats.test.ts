/** @vitest-environment node */
/**
 * Unit tests for the chat read and creation routes.
 *
 * Layer: unit.
 * Goal: what `POST /api/chats`, the two listings and the rename write, refuse and enqueue, against
 * the in-memory repositories and the BullMQ double. The lifecycle routes — messages, archive,
 * restore and delete — are covered by `chats.lifecycle.test.ts`.
 * Mocks: the `bullmq` module; everything else is a real core double.
 */
import { chatDetail, chatSummary, JOB_NAMES, listChatsResponse } from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import { CREATE_BODY, REPO_URL, seedChat } from '../testing/chat-fixtures';
import { foreignRequest, readRequest, writeRequest } from '../testing/requests';
import { createTestContainer } from '../testing/test-container';

import {
  archiveChat,
  createChat,
  getChat,
  listChats,
  renameChat,
  TITLE_LENGTH,
  titleFromPrompt,
} from './chats';

vi.mock('bullmq', () => import('../testing/fake-queue'));

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
