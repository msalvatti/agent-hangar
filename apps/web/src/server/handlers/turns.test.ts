/** @vitest-environment node */
/**
 * Unit tests for turn cancellation.
 *
 * Layer: unit.
 * Goal: a turn the worker has not started is removed from the queue and closed here; anything
 * already executing is handed to the worker over the command channel *and* recorded as cancelled
 * by this route, so an accepted stop is never overwritten by the outcome the worker was about to
 * write; a finished turn is refused. Retrying is covered by `turn-retry.test.ts`.
 * Mocks: the `bullmq` module.
 */
import { okResponse, turnCommand, turnCommandChannel } from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import { foreignRequest } from '../testing/requests';
import { createTestContainer } from '../testing/test-container';
import { cancelRequest, seedTurn } from '../testing/turn-fixtures';

import { NO_USAGE } from './guards';
import { cancelTurn } from './turns';

vi.mock('bullmq', () => import('../testing/fake-queue'));

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
   * A turn the worker already picked up keeps its container and its exec stream there, so the
   * request is published and acknowledged with `202`. The outcome, though, is recorded here: `202`
   * says the turn is being stopped, and leaving the record to the worker is what let a turn the
   * API had already accepted a cancellation for come back as `FAILED`.
   */
  it('publishes a cancel command for a running turn and records the cancellation', async () => {
    const harness = createTestContainer();
    const turnId = await seedTurn(harness);
    await harness.doubles.repos.turns.setStatus(turnId, 'RUNNING');

    const response = await cancelTurn(harness.container, cancelRequest(turnId), { id: turnId });
    expect(response.status).toBe(202);
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'CANCELLED' });
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
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'CANCELLED' });
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
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'CANCELLED' });
  });

  /**
   * The window this route's write exists to close, driven at the seam where it is real: the worker
   * had already decided the turn could not run and records `FAILED` while this request is between
   * its publish and its own write. Before, the request answered `202` — telling the browser the
   * turn was being stopped — and the row then read `FAILED`, contradicting it. Now the write is
   * refused, the answer is `409`, and what the user is told matches what is stored.
   */
  it('refuses rather than promising a cancel the worker has already outrun', async () => {
    const harness = createTestContainer();
    const turnId = await seedTurn(harness);
    await harness.doubles.repos.turns.setStatus(turnId, 'RUNNING');
    const publish = harness.doubles.redis.publish.bind(harness.doubles.redis);
    vi.spyOn(harness.doubles.redis, 'publish').mockImplementation(async (channel, message) => {
      const delivered = await publish(channel, message);
      await harness.doubles.repos.turns.finish(
        turnId,
        'FAILED',
        NO_USAGE,
        'the worker got there first',
      );
      return delivered;
    });

    const response = await cancelTurn(harness.container, cancelRequest(turnId), { id: turnId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'TURN_NOT_CANCELLABLE' } });
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({
      status: 'FAILED',
      error: 'the worker got there first',
    });
  });

  /**
   * The same window on the queued path. The job was taken off the queue, so nothing is left to run
   * — putting it back would be the wrong repair — and the turn already carries the outcome the
   * worker wrote, so the request reports that rather than claiming a cancellation.
   */
  it('refuses without re-enqueueing when the turn finished after its job was removed', async () => {
    const harness = createTestContainer();
    const turnId = await seedTurn(harness);
    const job = harness.doubles.queues.chatTurns.jobs.get(turnId);
    const remove = job?.remove.bind(job);
    vi.spyOn(job!, 'remove').mockImplementation(async () => {
      await remove?.();
      await harness.doubles.repos.turns.finish(
        turnId,
        'FAILED',
        NO_USAGE,
        'the worker got there first',
      );
    });

    const response = await cancelTurn(harness.container, cancelRequest(turnId), { id: turnId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'TURN_NOT_CANCELLABLE', message: 'This turn has already finished' },
    });
    expect(await harness.doubles.repos.turns.get(turnId)).toMatchObject({ status: 'FAILED' });
    expect(harness.doubles.queues.chatTurns.added).toHaveLength(1);
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
    // The code the page branches on and the sentence it shows.
    expect(await response.json()).toMatchObject({
      error: { code: 'TURN_NOT_CANCELLABLE', message: 'This turn has already finished' },
    });
    // And the worker is not told to stop something that has already stopped: the command channel
    // is shared, and a cancel published for a finished turn reaches a listener that may still be
    // there to act on it.
    expect(harness.doubles.redis.published).toEqual([]);
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
    // The turn is named on the line: this row is now `QUEUED` with no job behind it, and its id is
    // all anyone has to find it by.
    expect(
      harness.doubles
        .logOutput()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    ).toContainEqual(
      expect.objectContaining({ msg: 'could not undo a partial turn cancel', turnId }),
    );
  });

  /**
   * An unknown turn is a missing resource.
   */
  it('reports an unknown turn as missing', async () => {
    const { container } = createTestContainer();
    const response = await cancelTurn(container, cancelRequest('nope'), { id: 'nope' });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { message: 'Turn not found' } });
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
