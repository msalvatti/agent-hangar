/** @vitest-environment node */
/**
 * Unit tests for turn cancellation and turn retry.
 *
 * Layer: unit.
 * Goal: a turn the worker has not started is removed from the queue and closed here; anything
 * already executing is handed to the worker over the command channel, and a finished turn is
 * refused. Retrying re-dispatches the failed turn row itself and writes no message, so the chat
 * keeps exactly the prompts the user sent; every status other than `FAILED` is refused with a
 * stated code.
 * Mocks: the `bullmq` module.
 */
import {
  JOB_NAMES,
  okResponse,
  TURN_EVENT_FIELD,
  turnCommand,
  turnCommandChannel,
  turnEventsStreamKey,
} from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import type { FakeJobState } from '../testing/fake-queue';
import { foreignRequest } from '../testing/requests';
import { createTestContainer } from '../testing/test-container';
import type { TestContainer } from '../testing/test-container';

import { createChat } from './chats';
import { ENQUEUE_FAILED } from './dispatch';
import { CLAIM_RELEASED } from './guards';
import { cancelTurn, retryTurn } from './turns';

vi.mock('bullmq', () => import('../testing/fake-queue'));

/** A repository URL the contracts accept. */
const REPO_URL = 'https://github.com/acme/widgets';

/**
 * Builds a same-origin cancel request.
 *
 * @param id - Turn id.
 * @returns The request.
 */
function cancelRequest(id: string): Request {
  return new Request(`http://127.0.0.1:3000/api/turns/${id}/cancel`, {
    method: 'POST',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
  });
}

/** The prompt every seeded chat is started with; the only one its history should ever hold. */
const PROMPT = 'work';

/**
 * Builds a same-origin retry request.
 *
 * @param id - Turn id.
 * @returns The request.
 */
function retryRequest(id: string): Request {
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
async function seedChatTurn(harness: TestContainer): Promise<{ chatId: string; turnId: string }> {
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
async function seedTurn(harness: TestContainer): Promise<string> {
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
async function seedFailedTurn(
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
  const job = harness.doubles.queues.chatTurns.jobs.get(seeded.turnId);
  if (job === undefined) {
    throw new Error('The seeded chat did not enqueue a job');
  }
  job.state = jobState;
  harness.doubles.queues.chatTurns.added.length = 0;
  return seeded;
}

/**
 * Reads back what the chat actually persisted for the user.
 *
 * @param harness - The test container.
 * @param chatId - Chat to read.
 * @returns The content of every persisted USER message, in order.
 */
async function userPrompts(harness: TestContainer, chatId: string): Promise<string[]> {
  const messages = await harness.doubles.repos.messages.listByChat(chatId);
  return messages.filter((message) => message.role === 'USER').map((message) => message.content);
}

describe('cancelTurn', () => {
  /**
   * A job still waiting in the queue is removed and the turn closed in one request; nothing is
   * published, because no worker holds the turn.
   */
  it('removes a queued job and closes the turn', async () => {
    const harness = createTestContainer();
    const turnId = await seedTurn(harness);

    const response = await cancelTurn(harness.container, cancelRequest(turnId), { id: turnId });
    expect(response.status).toBe(200);
    expect(okResponse.parse(await response.json())).toEqual({ ok: true });
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'CANCELLED' });
    expect(harness.doubles.queues.chatTurns.jobs.has(turnId)).toBe(false);
    expect(harness.doubles.redis.published).toEqual([]);
  });

  /**
   * A turn the worker already picked up cannot be closed from here: the container and the exec
   * stream belong to the worker, so the request is published and acknowledged with `202`.
   */
  it('publishes a cancel command for a running turn', async () => {
    const harness = createTestContainer();
    const turnId = await seedTurn(harness);
    await harness.doubles.repos.turns.setStatus(turnId, 'RUNNING');

    const response = await cancelTurn(harness.container, cancelRequest(turnId), { id: turnId });
    expect(response.status).toBe(202);
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'RUNNING' });
    const [published] = harness.doubles.redis.published;
    expect(published?.channel).toBe(turnCommandChannel(turnId));
    expect(turnCommand.parse(JSON.parse(published?.message ?? ''))).toEqual({ type: 'cancel' });
  });

  /**
   * The race the two paths exist for: the turn still reads `QUEUED` but BullMQ has already handed
   * the job out, so removing it would be a lie. The command channel is used instead.
   */
  it('falls back to the command channel when the queued job is no longer removable', async () => {
    const harness = createTestContainer();
    const turnId = await seedTurn(harness);
    harness.doubles.queues.chatTurns.jobs.get(turnId)!.state = 'active';

    const response = await cancelTurn(harness.container, cancelRequest(turnId), { id: turnId });
    expect(response.status).toBe(202);
    expect(harness.doubles.redis.published).toHaveLength(1);
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'QUEUED' });
  });

  /**
   * The same race, one step later: the job was still removable when its state was read and BullMQ
   * promoted it to active before the removal, so the removal is refused. That is the running case,
   * not a broken request — the cancel has to reach the worker instead of surfacing as a 500.
   */
  it('falls back to the command channel when the job started between the check and the removal', async () => {
    const harness = createTestContainer();
    const turnId = await seedTurn(harness);
    const job = harness.doubles.queues.chatTurns.jobs.get(turnId)!;
    vi.spyOn(job, 'remove').mockImplementation(() => {
      job.state = 'active';
      return Promise.reject(new Error('Missing lock for job'));
    });

    const response = await cancelTurn(harness.container, cancelRequest(turnId), { id: turnId });

    expect(response.status).toBe(202);
    expect(harness.doubles.redis.published).toHaveLength(1);
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'QUEUED' });
  });

  /**
   * The other side of that branch: the removal failed while the job is still sitting in the queue,
   * which is the store being broken rather than a race. Reporting it as a successful cancel would
   * leave the turn queued and the user believing it was stopped.
   */
  it('reports a removal that fails while the job is still queued', async () => {
    const harness = createTestContainer();
    const turnId = await seedTurn(harness);
    const job = harness.doubles.queues.chatTurns.jobs.get(turnId)!;
    vi.spyOn(job, 'remove').mockRejectedValue(new Error('redis down'));

    const response = await cancelTurn(harness.container, cancelRequest(turnId), { id: turnId });

    expect(response.status).toBe(500);
    expect(harness.doubles.redis.published).toEqual([]);
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'QUEUED' });
  });

  /**
   * BullMQ may have released the job entirely; a missing job is the same situation as an
   * unremovable one, so the request still reaches the worker.
   */
  it('falls back to the command channel when the job is gone', async () => {
    const harness = createTestContainer();
    const turnId = await seedTurn(harness);
    harness.doubles.queues.chatTurns.canFindJobs = false;

    const response = await cancelTurn(harness.container, cancelRequest(turnId), { id: turnId });
    expect(response.status).toBe(202);
    expect(harness.doubles.redis.published).toHaveLength(1);
  });

  /**
   * A finished turn has nothing to cancel, and saying so is more useful than a silent success the
   * UI would render as a pending cancel.
   */
  it('refuses to cancel a finished turn', async () => {
    const harness = createTestContainer();
    const turnId = await seedTurn(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    const response = await cancelTurn(harness.container, cancelRequest(turnId), { id: turnId });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TURN_NOT_CANCELLABLE' } });
  });

  /**
   * The job is removed from Redis before the terminal status reaches Postgres, and the two stores
   * cannot commit together. The rule this protects is that a failure of the second write does not
   * strand the turn: without the undo the queue entry is gone while the row still says `QUEUED`,
   * so nothing would ever run it and a later cancel would only publish a command for work that can
   * never start. The job goes back with the same id and payload, so a retry finds what it started
   * from.
   */
  it('puts the queued job back when the cancelled status cannot be written', async () => {
    const harness = createTestContainer();
    const turnId = await seedTurn(harness);
    vi.spyOn(harness.doubles.repos.turns, 'finish').mockRejectedValue(
      new Error('database unreachable'),
    );

    const response = await cancelTurn(harness.container, cancelRequest(turnId), { id: turnId });

    expect(response.status).toBe(500);
    expect(harness.doubles.queues.chatTurns.jobs.has(turnId)).toBe(true);
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'QUEUED' });
    expect(harness.doubles.redis.published).toEqual([]);
  });

  /**
   * Both the status write and the undo failing is the one case compensation cannot repair: the
   * request still fails with the error that explains it rather than with the undo's, and the log
   * line naming the turn is the only record that a queued turn has no job behind it.
   */
  it('reports a cancel it could not undo', async () => {
    const harness = createTestContainer();
    const turnId = await seedTurn(harness);
    vi.spyOn(harness.doubles.repos.turns, 'finish').mockRejectedValue(
      new Error('database unreachable'),
    );
    harness.doubles.queues.chatTurns.addFailure = new Error('redis unreachable');

    const response = await cancelTurn(harness.container, cancelRequest(turnId), { id: turnId });

    expect(response.status).toBe(500);
    expect(harness.doubles.queues.chatTurns.jobs.has(turnId)).toBe(false);
    expect(harness.doubles.logOutput()).toContain('could not undo a partial turn cancel');
  });

  /**
   * An unknown turn is a missing resource.
   */
  it('reports an unknown turn as missing', async () => {
    const { container } = createTestContainer();
    const response = await cancelTurn(container, cancelRequest('nope'), { id: 'nope' });
    expect(response.status).toBe(404);
  });

  /**
   * Cancel is a state-changing route, so it carries the same origin guard as the rest: a foreign
   * page must not be able to stop the user's work.
   */
  it('rejects a cross-origin cancel', async () => {
    const harness = createTestContainer();
    const turnId = await seedTurn(harness);
    const request = foreignRequest(`/api/turns/${turnId}/cancel`, 'POST', {});
    const response = await cancelTurn(harness.container, request, { id: turnId });
    expect(response.status).toBe(403);
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'QUEUED' });
  });
});

describe('retryTurn', () => {
  /**
   * The defect this route exists for, measured where it actually was: the chat holds one USER row
   * before the retry and exactly one after it. Asserting the persisted rows rather than a call
   * count is the point — the duplicate was in Postgres, so a screen that merely hid it would
   * disagree with the record on the next reload.
   */
  it('re-runs a failed turn without persisting a second user message', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedFailedTurn(harness);
    expect(await userPrompts(harness, chatId)).toEqual([PROMPT]);

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(200);
    expect(okResponse.parse(await response.json())).toEqual({ ok: true });
    expect(await userPrompts(harness, chatId)).toEqual([PROMPT]);
    expect(await harness.doubles.repos.turns.listByChat(chatId)).toHaveLength(1);
  });

  /**
   * Re-queueing has to actually reach the worker, on the same turn id, with the chat's history
   * unchanged — that history is where the worker reads the prompt from, so an unchanged history
   * is what "runs against the original prompt" means. The row is `QUEUED` again with its job id
   * set and every trace of the failed attempt gone, which is what the transcript renders.
   */
  it('puts the same turn back on the queue against the original prompt', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedFailedTurn(harness);

    await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(harness.doubles.queues.chatTurns.added).toEqual([
      {
        name: JOB_NAMES.runTurn,
        data: { turnId },
        opts: expect.objectContaining({ jobId: turnId }) as unknown,
      },
    ]);
    expect(await userPrompts(harness, chatId)).toEqual([PROMPT]);
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({
      status: 'QUEUED',
      queueJobId: turnId,
      error: null,
      startedAt: null,
      finishedAt: null,
      inputTokens: null,
      outputTokens: null,
      stepCount: 0,
    });
  });

  /**
   * The transport-error shape of the same precondition: the processor threw, so BullMQ retained
   * the job as `failed` rather than `completed`. Retention keeps both, and both would swallow the
   * re-dispatch, so both are pinned.
   */
  it('re-dispatches a turn whose job was retained as failed', async () => {
    const harness = createTestContainer();
    const { turnId } = await seedFailedTurn(harness, 'failed');

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(200);
    expect(harness.doubles.queues.chatTurns.added).toHaveLength(1);
    expect(harness.doubles.queues.chatTurns.added[0]?.data).toEqual({ turnId });
  });

  /**
   * Reusing the turn row means reusing its event stream, and that stream still ends in the
   * previous attempt's terminal event. A client that joins without a resume point — every client
   * that loaded the failure from history — would replay it and be told the turn failed before the
   * new attempt had written anything. The attempt boundary is the deleted stream.
   */
  it('clears the events of the previous attempt before re-dispatching', async () => {
    const harness = createTestContainer();
    const { turnId } = await seedFailedTurn(harness);
    await harness.doubles.redis.xadd(
      turnEventsStreamKey(turnId),
      TURN_EVENT_FIELD,
      JSON.stringify({ type: 'turn.failed', error: { code: 'auth', message: 'nope' } }),
    );
    expect(await harness.doubles.redis.xrange(turnEventsStreamKey(turnId), '-', '+')).toHaveLength(
      1,
    );

    await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(await harness.doubles.redis.xrange(turnEventsStreamKey(turnId), '-', '+')).toEqual([]);
  });

  /**
   * A turn that is no longer the newest one cannot be run again. The events route streams the
   * chat's last turn and the worker rebuilds its context from the whole message history, so
   * re-running an older row would answer the newest prompt while the client watched a different
   * turn — and record the result against one nobody is looking at.
   */
  it('refuses to retry a failed turn that a later turn has superseded', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedFailedTurn(harness);
    const newer = await harness.doubles.repos.turns.create({ chatId, model: 'gpt-5.6-sol' });
    await harness.doubles.repos.turns.finish(newer.id, 'SUCCEEDED', {
      inputTokens: 1,
      outputTokens: 1,
      stepCount: 1,
    });

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TURN_NOT_RETRYABLE' } });
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'FAILED' });
    expect(harness.doubles.queues.chatTurns.added).toEqual([]);
  });

  /**
   * A Redis that refuses to clear the previous attempt leaves the turn failed rather than queued
   * behind a job that would replay the old events, so the retry can simply be pressed again.
   */
  it('fails the turn again when the previous attempt cannot be cleared', async () => {
    const harness = createTestContainer();
    const { turnId } = await seedFailedTurn(harness);
    vi.spyOn(harness.doubles.redis, 'del').mockRejectedValue(new Error('redis unreachable'));

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(500);
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({
      status: 'FAILED',
      error: ENQUEUE_FAILED,
    });
    expect(harness.doubles.queues.chatTurns.added).toEqual([]);
  });

  /**
   * The window the worker leaves open: it records the turn's outcome before its processor returns,
   * so a Retry can arrive while the row already reads `FAILED` and the job is still `active`.
   * Enqueuing there is answered with the running job and nothing new runs — and the turn would be
   * left `QUEUED` behind a job about to complete, which no worker picks up and `cancelTurn` cannot
   * remove, wedging the chat against every later message. It is refused instead, and because the
   * refusal comes before the claim the row keeps its status and the error that explains it.
   */
  it('refuses a retry that arrives before the previous attempt finished', async () => {
    const harness = createTestContainer();
    const { turnId } = await seedFailedTurn(harness, 'active');

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'PREVIOUS_ATTEMPT_RUNNING' },
    });
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({
      status: 'FAILED',
      error: 'OpenAI rejected the request',
    });
    expect(harness.doubles.queues.chatTurns.added).toEqual([]);
    expect(harness.doubles.queues.chatTurns.jobs.get(turnId)?.removed).toBeFalsy();
  });

  /**
   * The window always closes, so the advice the refusal gives is true rather than hopeful: once
   * the processor returns and the job is `completed`, the very next Retry releases it and runs.
   */
  it('accepts the same retry once that attempt has finished', async () => {
    const harness = createTestContainer();
    const { turnId } = await seedFailedTurn(harness, 'active');
    expect((await retryTurn(harness.container, retryRequest(turnId), { id: turnId })).status).toBe(
      409,
    );

    const job = harness.doubles.queues.chatTurns.jobs.get(turnId);
    if (job === undefined) {
      throw new Error('The seeded chat did not enqueue a job');
    }
    job.state = 'completed';

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(200);
    expect(harness.doubles.queues.chatTurns.added).toHaveLength(1);
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'QUEUED' });
  });

  /**
   * A cancelled turn was stopped on purpose. Re-running it would undo a decision the user made
   * rather than recover from an accident, so it is refused with a code the UI can render; sending
   * the prompt again is the way to run it, and that records a new intent where it can be seen.
   */
  it('refuses to retry a cancelled turn', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChatTurn(harness);
    await harness.doubles.repos.turns.finish(turnId, 'CANCELLED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TURN_NOT_RETRYABLE' } });
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'CANCELLED' });
    expect(await userPrompts(harness, chatId)).toEqual([PROMPT]);
  });

  /**
   * A succeeded turn already answered its prompt. Running it again would hang a second answer off
   * one question and leave a transcript no reader can account for.
   */
  it('refuses to retry a succeeded turn', async () => {
    const harness = createTestContainer();
    const { turnId } = await seedChatTurn(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 1,
      outputTokens: 1,
      stepCount: 1,
    });

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TURN_NOT_RETRYABLE' } });
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'SUCCEEDED' });
  });

  /**
   * A turn that has not finished is refused as work in progress rather than as unretryable: the
   * first answer tells the caller to wait or cancel, which is something they can act on, while
   * the second would only be true for the moment.
   */
  it('refuses to retry a turn that is still live, naming the running turn', async () => {
    const harness = createTestContainer();
    const { turnId } = await seedChatTurn(harness);
    await harness.doubles.repos.turns.setStatus(turnId, 'RUNNING');
    harness.doubles.queues.chatTurns.added.length = 0;

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TURN_IN_PROGRESS' } });
    expect(harness.doubles.queues.chatTurns.added).toEqual([]);
  });

  /**
   * A failed turn under a chat that has since acquired a live turn is refused for the same reason
   * a second message is: the worker holds a container for that chat and writes rows against it.
   */
  it('refuses to retry while another turn of the chat is live', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedFailedTurn(harness);
    await harness.doubles.repos.turns.create({ chatId, model: 'gpt-5.6-sol' });

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TURN_IN_PROGRESS' } });
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'FAILED' });
  });

  /**
   * An archived chat has had its workspace torn down, so queueing work under it would race the
   * teardown exactly as a message would. The turn is left failed and retryable after a restore.
   */
  it('refuses to retry a turn of an archived chat', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedFailedTurn(harness);
    await harness.doubles.repos.chats.setStatus(chatId, 'ARCHIVED');

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'CHAT_ARCHIVED' } });
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'FAILED' });
  });

  /**
   * Credentials are checked before anything is written, so a chat is never left holding a queued
   * turn that could not have run.
   */
  it('refuses to retry while a credential is missing, writing nothing', async () => {
    const harness = createTestContainer();
    const { turnId } = await seedFailedTurn(harness);
    await harness.doubles.secrets.remove('OPENAI_API_KEY');

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'SECRETS_MISSING' } });
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'FAILED' });
    expect(harness.doubles.queues.chatTurns.added).toEqual([]);
  });

  /**
   * The precondition and the write are one statement: a turn that stops being `FAILED` between
   * the read and the write matches nothing, and the request is answered with the same 409 it
   * would have got had it read the later state. Modelled by making `requeue` decline.
   */
  it('refuses when the turn stopped being failed before the write', async () => {
    const harness = createTestContainer();
    const { turnId } = await seedFailedTurn(harness);
    vi.spyOn(harness.doubles.repos.turns, 'requeue').mockResolvedValue(null);

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TURN_NOT_RETRYABLE' } });
    expect(harness.doubles.queues.chatTurns.added).toEqual([]);
  });

  /**
   * The window the pre-check cannot close: a message claims the chat between the live-turn read
   * and the requeue write. Re-reading after its own write is what lets the retry see the rival at
   * all, and the claim is given back so the chat is not left with two live turns — which the
   * worker resolves by failing whichever job loses its in-process claim, not by refusing cleanly.
   */
  it('gives the claim back when another turn claims the chat during the requeue', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedFailedTurn(harness);
    const { turns } = harness.doubles.repos;
    const requeue = turns.requeue.bind(turns);
    vi.spyOn(turns, 'requeue').mockImplementation(async (id) => {
      await turns.create({ chatId, model: 'gpt-5.6-sol' });
      return requeue(id);
    });

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TURN_IN_PROGRESS' } });
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({
      status: 'FAILED',
      error: CLAIM_RELEASED,
    });
    expect(harness.doubles.queues.chatTurns.added).toEqual([]);
  });

  /**
   * The same window against the other racing operation: an archive commits its status write while
   * the retry's turn is still `FAILED`, so the archive's own live-turn check cannot see it. The
   * retry re-reads the status after its write and stands down, which is what stops a turn being
   * dispatched into a chat whose workspace teardown is already queued.
   */
  it('gives the claim back when the chat is archived during the requeue', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedFailedTurn(harness);
    const { chats, turns } = harness.doubles.repos;
    const requeue = turns.requeue.bind(turns);
    vi.spyOn(turns, 'requeue').mockImplementation(async (id) => {
      await chats.setStatus(chatId, 'ARCHIVED');
      return requeue(id);
    });

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'CHAT_ARCHIVED' } });
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'FAILED' });
    expect(harness.doubles.queues.chatTurns.added).toEqual([]);
  });

  /**
   * A chat deleted while the retry holds its claim is a 404 rather than a conflict: there is no
   * chat left to run the turn against, so there is nothing for the caller to wait for either.
   */
  it('reports a chat deleted during the requeue as missing', async () => {
    const harness = createTestContainer();
    const { turnId } = await seedFailedTurn(harness);
    const { chats, turns } = harness.doubles.repos;
    const requeue = turns.requeue.bind(turns);
    vi.spyOn(turns, 'requeue').mockImplementation(async (id) => {
      const requeued = await requeue(id);
      vi.spyOn(chats, 'getById').mockResolvedValue(null);
      return requeued;
    });

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(404);
    expect(harness.doubles.queues.chatTurns.added).toEqual([]);
  });

  /**
   * Both the claim and its release failing is the case compensation cannot repair: the request
   * still fails with the conflict that explains it rather than with the release's error, and the
   * log line naming the chat and the turn is the only record that a queued turn has no job.
   */
  it('reports a retried claim it could not release', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedFailedTurn(harness);
    const { turns } = harness.doubles.repos;
    const requeue = turns.requeue.bind(turns);
    vi.spyOn(turns, 'requeue').mockImplementation(async (id) => {
      await turns.create({ chatId, model: 'gpt-5.6-sol' });
      return requeue(id);
    });
    vi.spyOn(turns, 'finish').mockRejectedValue(new Error('database unreachable'));

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TURN_IN_PROGRESS' } });
    expect(harness.doubles.logOutput()).toContain('could not release a retried turn claim');
    expect(harness.doubles.queues.chatTurns.added).toEqual([]);
  });

  /**
   * A queue that refuses the job leaves the turn failed again rather than queued with nothing
   * behind it, so the chat's work slot is free and the retry can simply be pressed again.
   */
  it('fails the turn again when the queue refuses the job', async () => {
    const harness = createTestContainer();
    const { turnId } = await seedFailedTurn(harness);
    harness.doubles.queues.chatTurns.addFailure = new Error('redis unreachable');

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(500);
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({
      status: 'FAILED',
      error: ENQUEUE_FAILED,
    });
  });

  /** An unknown turn is a missing resource, exactly as it is for cancel. */
  it('reports an unknown turn as missing', async () => {
    const { container } = createTestContainer();
    const response = await retryTurn(container, retryRequest('nope'), { id: 'nope' });
    expect(response.status).toBe(404);
  });

  /**
   * A turn whose chat is gone cannot be run: the worker resolves the repository and the branch
   * through the chat, so there is nothing left to run it against.
   */
  it('reports a turn whose chat has been deleted as missing', async () => {
    const harness = createTestContainer();
    const { turnId } = await seedFailedTurn(harness);
    vi.spyOn(harness.doubles.repos.chats, 'getById').mockResolvedValue(null);

    const response = await retryTurn(harness.container, retryRequest(turnId), { id: turnId });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { message: 'Chat not found' } });
  });

  /**
   * Retry starts agent work, so it carries the same origin guard as every other state-changing
   * route: a foreign page must not be able to spend the user's tokens.
   */
  it('rejects a cross-origin retry', async () => {
    const harness = createTestContainer();
    const { turnId } = await seedFailedTurn(harness);

    const response = await retryTurn(
      harness.container,
      foreignRequest(`/api/turns/${turnId}/retry`, 'POST', {}),
      { id: turnId },
    );

    expect(response.status).toBe(403);
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'FAILED' });
    expect(harness.doubles.queues.chatTurns.added).toEqual([]);
  });
});
