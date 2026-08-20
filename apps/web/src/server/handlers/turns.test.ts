/** @vitest-environment node */
/**
 * Unit tests for turn cancellation.
 *
 * Layer: unit.
 * Goal: a turn the worker has not started is removed from the queue and closed here; anything
 * already executing is handed to the worker over the command channel, and a finished turn is
 * refused.
 * Mocks: the `bullmq` module.
 */
import { okResponse, turnCommand, turnCommandChannel } from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import { foreignRequest } from '../testing/requests';
import { createTestContainer } from '../testing/test-container';
import type { TestContainer } from '../testing/test-container';

import { createChat } from './chats';
import { cancelTurn } from './turns';

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

/**
 * Creates a chat with a queued turn through the API.
 *
 * @param harness - The test container.
 * @returns The turn id.
 */
async function seedTurn(harness: TestContainer): Promise<string> {
  const request = new Request('http://127.0.0.1:3000/api/chats', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ repoUrl: REPO_URL, baseBranch: 'main', prompt: 'work' }),
  });
  const response = await createChat(harness.container, request);
  const body = (await response.json()) as { turnId: string };
  return body.turnId;
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
