/** @vitest-environment node */
/**
 * Unit tests for the chat lifecycle routes: message, archive, restore and delete.
 *
 * Layer: unit.
 * Goal: the orderings that decide what survives a half-failed request — the claim that keeps two
 * simultaneous messages from both queueing a turn, the compensations that undo a status write, and
 * the teardown that must not go out before the delete commits.
 * Mocks: the `bullmq` module; everything else is a real core double.
 */
import {
  chatSummary,
  JOB_NAMES,
  postMessageResponse,
  RESTORATION_NOTICE_PREFIX,
} from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import { REPO_URL, seedChat } from '../testing/chat-fixtures';
import { writeRequest } from '../testing/requests';
import { createTestContainer } from '../testing/test-container';

import { archiveChat, deleteChat, postMessage, restoreChat } from './chats';
import { LIVE_STATUSES } from './guards';

vi.mock('bullmq', () => import('../testing/fake-queue'));

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

  /**
   * Two messages sent at the same instant both find the chat idle, because the live-turn check and
   * the turn that answers the message are separate writes. The rule this protects is that the chat
   * never ends up with two live turns racing the worker for one container: at most one request is
   * accepted, and the transcript gains exactly as many messages as were accepted.
   */
  it('never lets two simultaneous messages both queue a turn', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    const send = (prompt: string): Promise<Response> =>
      postMessage(
        harness.container,
        writeRequest(`/api/chats/${chatId}/messages`, 'POST', { prompt }),
        { id: chatId },
      );

    const responses = await Promise.all([send('first'), send('second')]);

    const accepted = responses.filter((response) => response.status === 201);
    expect(responses.every((response) => response.status === 201 || response.status === 409)).toBe(
      true,
    );
    expect(accepted.length).toBeLessThanOrEqual(1);
    const live = (await harness.doubles.repos.turns.listByChat(chatId)).filter((turn) =>
      LIVE_STATUSES.includes(turn.status),
    );
    expect(live).toHaveLength(accepted.length);
    // The seed's own turn is the first entry; anything past it belongs to an accepted message.
    expect(harness.doubles.queues.chatTurns.added).toHaveLength(1 + accepted.length);
    expect(await harness.doubles.repos.messages.listByChat(chatId)).toHaveLength(
      1 + accepted.length,
    );
  });

  /**
   * The losing side of that race, made deterministic: the live-turn check is blinded once, so the
   * request creates its claim while a rival turn is already live. It must give the claim back
   * rather than leave a `QUEUED` turn holding the chat's work slot for ever, and it must not have
   * written the user's message.
   */
  it('gives its claim back when another turn is already live', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    const turnsRepo = harness.doubles.repos.turns;
    // Only the pre-check is blinded; the claim check that follows reads the real rows.
    vi.spyOn(turnsRepo, 'listByChat').mockResolvedValueOnce([]);

    const response = await postMessage(
      harness.container,
      writeRequest(`/api/chats/${chatId}/messages`, 'POST', { prompt: 'hello' }),
      { id: chatId },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TURN_IN_PROGRESS' } });
    const turns = await turnsRepo.listByChat(chatId);
    expect(
      turns.filter((turn) => LIVE_STATUSES.includes(turn.status)).map((turn) => turn.id),
    ).toEqual([turnId]);
    expect(turns.find((turn) => turn.id !== turnId)).toMatchObject({ status: 'CANCELLED' });
    expect(await harness.doubles.repos.messages.listByChat(chatId)).toHaveLength(1);
    expect(harness.doubles.queues.chatTurns.added).toHaveLength(1);
  });

  /**
   * The claim is taken before the message is appended, so an append that fails has to release it
   * too: otherwise a failed request would leave the chat unable to accept any later message.
   */
  it('gives its claim back when the message cannot be appended', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    vi.spyOn(harness.doubles.repos.messages, 'append').mockRejectedValue(
      new Error('database unreachable'),
    );

    const response = await postMessage(
      harness.container,
      writeRequest(`/api/chats/${chatId}/messages`, 'POST', { prompt: 'hello' }),
      { id: chatId },
    );

    expect(response.status).toBe(500);
    const live = (await harness.doubles.repos.turns.listByChat(chatId)).filter((turn) =>
      LIVE_STATUSES.includes(turn.status),
    );
    expect(live).toEqual([]);
    expect(harness.doubles.queues.chatTurns.added).toHaveLength(1);
  });

  /**
   * Both the append and the release failing is the case nothing here can repair: the request still
   * fails with the append's own error and the log line naming the chat is the only record that a
   * turn is left holding the slot.
   */
  it('reports a claim it could not release', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    vi.spyOn(harness.doubles.repos.messages, 'append').mockRejectedValue(
      new Error('database unreachable'),
    );
    vi.spyOn(harness.doubles.repos.turns, 'finish').mockRejectedValue(
      new Error('database unreachable'),
    );

    const response = await postMessage(
      harness.container,
      writeRequest(`/api/chats/${chatId}/messages`, 'POST', { prompt: 'hello' }),
      { id: chatId },
    );

    expect(response.status).toBe(500);
    expect(harness.doubles.logOutput()).toContain('could not release a chat turn claim');
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
   * If the teardown cannot be enqueued the status write is undone: `ARCHIVED` is a status this
   * route refuses to act on, so a row left there after a failed enqueue would have no request left
   * that could ever ask for the teardown, and the workspace would stay alive forever.
   */
  it('puts the chat back to active when the teardown cannot be enqueued', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    harness.doubles.queues.workspaceGc.addFailure = new Error('redis unreachable');

    const response = await archiveChat(harness.container, writeRequest('/api/chats', 'POST'), {
      id: chatId,
    });

    expect(response.status).toBe(500);
    const [chat] = await harness.doubles.repos.chats.list();
    expect(chat).toMatchObject({ status: 'ACTIVE', archivedAt: null });
  });

  /**
   * Both the enqueue and the undo failing is the one case compensation cannot repair: the request
   * still fails with the enqueue's own error, and the log line is the only record of the mismatch.
   */
  it('reports a mismatch it could not repair when archiving fails twice over', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    harness.doubles.queues.workspaceGc.addFailure = new Error('redis unreachable');
    const chatsRepo = harness.doubles.repos.chats;
    const originalSetStatus = chatsRepo.setStatus.bind(chatsRepo);
    // The compensating write asks for 'ACTIVE'; only that call is made to fail, so the archiving
    // write it follows still happens for real.
    vi.spyOn(chatsRepo, 'setStatus').mockImplementation((id, status) =>
      status === 'ACTIVE'
        ? Promise.reject(new Error('database unreachable'))
        : originalSetStatus(id, status),
    );

    const response = await archiveChat(harness.container, writeRequest('/api/chats', 'POST'), {
      id: chatId,
    });

    expect(response.status).toBe(500);
    expect(harness.doubles.logOutput()).toContain('could not undo a partial chat archive');
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
   * If the restoration notice cannot be appended the status write is undone: `ACTIVE` is a status
   * this route refuses to act on, so a row left there after a failed append would have no request
   * left that could ever retry the notice explaining what the model lost.
   */
  it('puts the chat back to archived when the restoration notice cannot be appended', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    await archiveChat(harness.container, writeRequest('/api/chats', 'POST'), { id: chatId });
    vi.spyOn(harness.doubles.repos.messages, 'append').mockRejectedValue(
      new Error('database unreachable'),
    );

    const response = await restoreChat(harness.container, writeRequest('/api/chats', 'POST'), {
      id: chatId,
    });

    expect(response.status).toBe(500);
    const [chat] = await harness.doubles.repos.chats.list();
    expect(chat).toMatchObject({ status: 'ARCHIVED' });
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
   * With a live workspace the teardown job goes out once the row is gone; the workspace is read
   * before the delete, because the cascade clears its chat reference.
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
   * The teardown is enqueued only after the delete commits. The rule this protects is that a job
   * the worker can see never names a chat that is still `ACTIVE`: with the enqueue first, a delete
   * that failed left a queued teardown that would destroy a live chat's workspace.
   */
  it('enqueues no teardown when the delete fails', async () => {
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
    vi.spyOn(harness.doubles.repos.chats, 'delete').mockRejectedValue(
      new Error('database unreachable'),
    );

    const response = await deleteChat(harness.container, writeRequest('/api/chats', 'DELETE'), {
      id: chatId,
    });

    expect(response.status).toBe(500);
    expect(harness.doubles.queues.workspaceGc.added).toEqual([]);
    expect(await harness.doubles.repos.chats.getById(chatId)).toMatchObject({ status: 'ACTIVE' });
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
