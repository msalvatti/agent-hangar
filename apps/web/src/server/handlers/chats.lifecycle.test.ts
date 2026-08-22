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
    // The prompt names the turn that answers it, exactly as every other writer of a message does.
    expect(messages[1]).toMatchObject({ role: 'USER', turnId: nextTurn });
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
    // The sentence as well as the code: the code is what the page branches on, the sentence is
    // what it shows, and only the sentence tells the user what to do about it.
    expect(await response.json()).toMatchObject({
      error: { code: 'CHAT_ARCHIVED', message: 'Restore the chat before sending messages' },
    });
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
   * the turn that answers the message are separate writes. Two rules are protected here. The chat
   * never ends up with two live turns racing the worker for one container — at most one request is
   * accepted, and the transcript gains exactly as many messages as were accepted. And whatever the
   * outcome, the chat is left usable: refusing on sight of a rival means both requests can back off
   * and neither message land, which is allowed, but a claim left behind by either of them would
   * wedge the chat against every later message, which is not. The upper bound rather than an exact
   * count is deliberate — which side wins depends on how the two inserts and reads interleave, and
   * pinning the count would assert the scheduler rather than the rule.
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

    for (const turn of live) {
      await harness.doubles.repos.turns.finish(turn.id, 'SUCCEEDED', {
        inputTokens: 0,
        outputTokens: 0,
        stepCount: 0,
      });
    }
    expect((await send('third')).status).toBe(201);
  });

  /**
   * A message and an archive race on different fields: the message checks the status, the archive
   * checks for live turns, and each writes after the other has read. The rule this protects is
   * that the pair cannot both succeed — an archived chat whose workspace teardown is queued while
   * a turn it just accepted is still live would have the worker destroy the container out from
   * under itself. Whichever side gives way, the two stores agree afterwards: a queued teardown
   * only ever accompanies a chat with no live turn.
   */
  it('never archives a chat and accepts a message for it at the same time', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });

    const [message, archive] = await Promise.all([
      postMessage(
        harness.container,
        writeRequest(`/api/chats/${chatId}/messages`, 'POST', { prompt: 'one more thing' }),
        { id: chatId },
      ),
      archiveChat(harness.container, writeRequest('/api/chats', 'POST'), { id: chatId }),
    ]);

    expect([message.status, archive.status].every((status) => status < 500)).toBe(true);
    expect(message.status === 201 && archive.status === 200).toBe(false);
    const chat = await harness.doubles.repos.chats.getById(chatId);
    const live = (await harness.doubles.repos.turns.listByChat(chatId)).filter((turn) =>
      LIVE_STATUSES.includes(turn.status),
    );
    if (harness.doubles.queues.workspaceGc.added.length > 0) {
      expect(chat).toMatchObject({ status: 'ARCHIVED' });
      expect(live).toEqual([]);
    } else {
      expect(chat).toMatchObject({ status: 'ACTIVE' });
    }
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
   * The ordering key is bumped inside the block that owns the claim, before the turn is dispatched.
   * The rule this protects is that a write which fails still releases the claim: placed after the
   * dispatch it could not, and placed before it but outside the block it would leave a `QUEUED`
   * turn holding the chat's work slot with no worker coming for it.
   */
  it('gives its claim back when the ordering key cannot be bumped', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    vi.spyOn(harness.doubles.repos.chats, 'touch').mockRejectedValue(
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
    expect(await harness.doubles.repos.messages.listByChat(chatId)).toHaveLength(1);
    expect(harness.doubles.queues.chatTurns.added).toHaveLength(1);
  });

  /**
   * A dispatch that fails marks its turn `FAILED`, which is what frees the chat's work slot. The
   * rule this protects is that a failed send leaves the chat retryable: were the turn left live,
   * the caller trying again would be told its own failed message was a turn already in progress,
   * with nothing running to wait for.
   */
  it('leaves the chat ready for a retry when the turn cannot be dispatched', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    harness.doubles.queues.chatTurns.addFailure = new Error('redis unreachable');

    const failed = await postMessage(
      harness.container,
      writeRequest(`/api/chats/${chatId}/messages`, 'POST', { prompt: 'hello' }),
      { id: chatId },
    );
    expect(failed.status).toBe(500);

    harness.doubles.queues.chatTurns.addFailure = null;
    const retried = await postMessage(
      harness.container,
      writeRequest(`/api/chats/${chatId}/messages`, 'POST', { prompt: 'hello' }),
      { id: chatId },
    );

    expect(retried.status).toBe(201);
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
    // Both ids: the chat whose next message will be refused, and the turn row still holding the
    // claim that refuses it.
    expect(records(harness)).toContainEqual(
      expect.objectContaining({
        msg: 'could not release a chat turn claim',
        chatId,
        // The turn the request opened, not the one already on the chat: that row is the claim, and
        // its id is the only handle anyone has on what has to be finished by hand.
        turnId: expect.any(String) as unknown,
      }),
    );
  });
});

/** The records the harness collected, parsed back from the lines pino wrote. */
function records(harness: ReturnType<typeof createTestContainer>): Record<string, unknown>[] {
  return harness.doubles
    .logOutput()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

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
    expect(await again.json()).toMatchObject({
      error: { code: 'ILLEGAL_TRANSITION', message: 'Chat is not active' },
    });
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
    // The chat is named on the line: this is the row left in a status nothing else will move it
    // out of, and an operator has no other way to find which one it was.
    expect(
      harness.doubles
        .logOutput()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    ).toContainEqual(
      expect.objectContaining({ msg: 'could not undo a partial chat archive', chatId }),
    );
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
   * And when the undo cannot be written either, the chat is left `ACTIVE` with no notice — a state
   * only the log records, so it records which chat.
   */
  it('reports a restore it could not undo', async () => {
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
    const setStatus = harness.doubles.repos.chats.setStatus.bind(harness.doubles.repos.chats);
    vi.spyOn(harness.doubles.repos.chats, 'setStatus').mockImplementation(async (id, status) =>
      status === 'ARCHIVED' && (await harness.doubles.repos.chats.getById(id))?.status === 'ACTIVE'
        ? Promise.reject(new Error('database unreachable'))
        : setStatus(id, status),
    );

    const response = await restoreChat(harness.container, writeRequest('/api/chats', 'POST'), {
      id: chatId,
    });

    expect(response.status).toBe(500);
    expect(records(harness)).toContainEqual(
      expect.objectContaining({ msg: 'could not undo a partial chat restore', chatId }),
    );
    vi.restoreAllMocks();
  });

  /**
   * The notice the model is left with names when the chat came back and the branch its work is on,
   * because the container it wrote that work in is gone.
   */
  it('tells the model when it came back and where its work is', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    await harness.doubles.repos.chats.updateRestoreHints(chatId, {
      workBranch: 'agent/earlier',
      lastPushedSha: 'deadbee',
    });
    await archiveChat(harness.container, writeRequest('/api/chats', 'POST'), { id: chatId });

    await restoreChat(harness.container, writeRequest('/api/chats', 'POST'), { id: chatId });

    const messages = await harness.doubles.repos.messages.listByChat(chatId);
    expect(messages.at(-1)?.content).toContain('agent/earlier');
    expect(messages.at(-1)?.content).toContain('Workspace recreated from history');
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
    expect(await active.json()).toMatchObject({
      error: { code: 'ILLEGAL_TRANSITION', message: 'Chat is not archived' },
    });
    const missing = await restoreChat(harness.container, writeRequest('/api/chats', 'POST'), {
      id: 'nope',
    });
    expect(missing.status).toBe(404);
    // The sentence a user reads when they follow a link to a chat somebody else deleted.
    expect(await missing.json()).toMatchObject({ error: { message: 'Chat not found' } });
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
    vi.spyOn(harness.doubles.repos.chats, 'deleteIfIdle').mockRejectedValue(
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
   * A chat that another request removed between this one's read and its write is reported as
   * missing rather than as held by a turn: both leave nothing deleted, but only one of them is
   * something the user can wait out, and "wait for the running turn" is nonsense advice about a
   * chat that no longer exists. The rival delete is run from inside the workspace read, which is
   * the step that actually sits between the two, so the window is the real one rather than a
   * stubbed answer.
   */
  it('reports a chat deleted by another request while this one was reading it', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    const { repos } = harness.doubles;
    const findLiveByChat = repos.workspaces.findLiveByChat.bind(repos.workspaces);
    vi.spyOn(repos.workspaces, 'findLiveByChat').mockImplementation(async (id: string) => {
      const live = await findLiveByChat(id);
      await repos.chats.deleteIfIdle(id);
      return live;
    });

    const response = await deleteChat(harness.container, writeRequest('/api/chats', 'DELETE'), {
      id: chatId,
    });

    expect(response.status).toBe(404);
    // The row went between the read and the delete, and what the caller is told is that the chat is
    // not there — the same answer as for one that never was.
    expect(await response.json()).toMatchObject({ error: { message: 'Chat not found' } });
    expect(harness.doubles.queues.workspaceGc.added).toEqual([]);
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
    expect(await busy.json()).toMatchObject({ error: { code: 'TURN_IN_PROGRESS' } });
    const missing = await deleteChat(harness.container, writeRequest('/api/chats', 'DELETE'), {
      id: 'nope',
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { message: 'Chat not found' } });
  });
});
