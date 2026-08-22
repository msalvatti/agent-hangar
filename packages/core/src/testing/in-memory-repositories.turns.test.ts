/**
 * Unit tests for the in-memory `TurnRepository`.
 *
 * Layer: unit.
 * Goal: every method behaves as the Prisma implementation will — the guarded `startedAt` stamp,
 * the conditional finish and requeue, and the preparation a turn records — with timestamps from
 * the injected clock and copies, not live rows, handed back. Split from
 * `in-memory-repositories.test.ts`, which the turn suite pushed past the size this repository
 * allows a file; the other repositories stayed there.
 * Mocks: FakeClock.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { NotFoundError } from '../errors.ts';

import { FakeClock } from './fake-clock.ts';
import { createInMemoryRepositories } from './in-memory-repositories.ts';
import type { InMemoryRepositories } from './in-memory-repositories.ts';

const T0 = new Date('2026-08-19T10:00:00.000Z');

let clock: FakeClock;
let repos: InMemoryRepositories;

beforeEach(() => {
  clock = new FakeClock(T0);
  repos = createInMemoryRepositories(clock);
});

async function seedChat(title = 'Fix tests') {
  return repos.chats.create({ title, repoUrl: 'https://github.com/acme/w', baseBranch: 'main' });
}

describe('TurnRepository', () => {
  /**
   * Create/setStatus/finish/get/listByChat: `PREPARING` stamps `startedAt` once; status updates
   * carry workspace/queue/error fields; `finish` writes usage, terminal status and `finishedAt`.
   */
  it('tracks the turn lifecycle', async () => {
    const chat = await seedChat();
    const turn = await repos.turns.create({ chatId: chat.id, model: 'gpt', queueJobId: 'q1' });
    expect(turn).toMatchObject({
      status: 'QUEUED',
      queueJobId: 'q1',
      startedAt: null,
      stepCount: 0,
    });
    expect((await repos.turns.create({ chatId: chat.id, model: 'gpt' })).queueJobId).toBeNull();

    clock.advance(1000);
    const preparing = await repos.turns.setStatus(turn.id, 'PREPARING', {
      workspaceId: 'w1',
    });
    expect(preparing.startedAt).toEqual(clock.now());
    expect(preparing.workspaceId).toBe('w1');
    clock.advance(1000);
    const running = await repos.turns.setStatus(turn.id, 'RUNNING', {
      queueJobId: 'q2',
      error: null,
    });
    expect(running.startedAt).toEqual(preparing.startedAt);
    expect(running.queueJobId).toBe('q2');

    const finished = await repos.turns.finish(
      turn.id,
      'FAILED',
      { inputTokens: 5, outputTokens: 2, stepCount: 1 },
      'boom',
    );
    expect(finished).toMatchObject({
      status: 'FAILED',
      inputTokens: 5,
      outputTokens: 2,
      stepCount: 1,
      error: 'boom',
    });
    expect(finished?.finishedAt).toEqual(clock.now());
    // A second outcome is refused rather than written over the first, so the row keeps what the
    // writer that got there first recorded.
    const succeeded = await repos.turns.finish(turn.id, 'SUCCEEDED', {
      inputTokens: 1,
      outputTokens: 1,
      stepCount: 2,
    });
    expect(succeeded).toBeNull();

    expect((await repos.turns.listByChat(chat.id)).map((t) => t.id)[0]).toBe(turn.id);
    expect((await repos.turns.get(turn.id))?.status).toBe('FAILED');
    expect(await repos.turns.get('missing')).toBeNull();
    await expect(repos.turns.create({ chatId: 'missing', model: 'm' })).rejects.toThrow(
      NotFoundError,
    );
    await expect(repos.turns.setStatus('missing', 'RUNNING')).rejects.toThrow(NotFoundError);
  });

  /**
   * `requeue` is the only backwards transition: a FAILED turn returns to QUEUED with every trace
   * of the failed attempt erased, so nothing about the previous run is rendered under a turn that
   * is waiting to run again.
   */
  it('records what a workspace was prepared on, and forgets it on requeue', async () => {
    const chat = await seedChat();
    const turn = await repos.turns.create({ chatId: chat.id, model: 'gpt' });
    expect(turn).toMatchObject({ preparedBranch: null, preparedSha: null });

    await repos.turns.recordPrepared(turn.id, { branch: 'agent/018f3a2b', headSha: 'abc1234def' });
    expect(await repos.turns.get(turn.id)).toMatchObject({
      preparedBranch: 'agent/018f3a2b',
      preparedSha: 'abc1234def',
    });

    // A retry prepares a workspace of its own, so the previous attempt's commit must not be left
    // for the transcript to state as this one's.
    await repos.turns.finish(
      turn.id,
      'FAILED',
      { inputTokens: 0, outputTokens: 0, stepCount: 0 },
      'boom',
    );
    expect(await repos.turns.requeue(turn.id)).toMatchObject({
      preparedBranch: null,
      preparedSha: null,
    });
  });

  /**
   * A turn that vanished — deleted with its chat while the runtime was still cloning — is not a
   * failure of the run, so the write is silent about it rather than throwing under the processor.
   */
  it('is silent when the turn it would record against is gone', async () => {
    await expect(
      repos.turns.recordPrepared('turn-that-never-existed', { branch: 'main', headSha: 'abc1234' }),
    ).resolves.toBeUndefined();
  });

  /**
   * The forward path of the same rule: a FAILED turn is the one status `requeue` moves, and it
   * returns to QUEUED with the whole record of the failed attempt cleared — error, timestamps and
   * usage — so a turn waiting to run again carries nothing from the run that failed.
   */
  it('requeues a failed turn and clears the failed attempt', async () => {
    const chat = await seedChat();
    const turn = await repos.turns.create({ chatId: chat.id, model: 'gpt' });
    await repos.turns.setStatus(turn.id, 'PREPARING');
    clock.advance(1000);
    await repos.turns.finish(
      turn.id,
      'FAILED',
      { inputTokens: 9, outputTokens: 4, stepCount: 3 },
      'boom',
    );

    const requeued = await repos.turns.requeue(turn.id);

    expect(requeued).toMatchObject({
      id: turn.id,
      status: 'QUEUED',
      error: null,
      startedAt: null,
      finishedAt: null,
      inputTokens: null,
      outputTokens: null,
      stepCount: 0,
    });
    expect(await repos.turns.get(turn.id)).toMatchObject({ status: 'QUEUED', error: null });
  });

  /**
   * Every other status answers `null` rather than moving: a turn that never failed has either
   * work behind it or an outcome nobody asked to undo, and a missing row is not a turn at all.
   * Answering instead of throwing is what lets the route turn "no" into a 409.
   */
  it('refuses to requeue a turn that is not failed, and an unknown turn', async () => {
    const chat = await seedChat();
    const turn = await repos.turns.create({ chatId: chat.id, model: 'gpt' });

    expect(await repos.turns.requeue(turn.id)).toBeNull();

    await repos.turns.finish(turn.id, 'CANCELLED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    expect(await repos.turns.requeue(turn.id)).toBeNull();

    // A turn of its own, because `finish` writes only over a live run: asking the cancelled turn
    // above to succeed is refused and leaves it cancelled, so a requeue asked of it would answer
    // for the cancelled case a second time while reading as though it covered the succeeded one.
    // The status is asserted before the requeue for the same reason — it is what makes the answer
    // below attributable to SUCCEEDED.
    const succeeded = await repos.turns.create({ chatId: chat.id, model: 'gpt' });
    await repos.turns.finish(succeeded.id, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    expect(await repos.turns.get(succeeded.id)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await repos.turns.requeue(succeeded.id)).toBeNull();

    expect(await repos.turns.requeue('missing')).toBeNull();
  });
});
