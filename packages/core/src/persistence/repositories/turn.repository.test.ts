/**
 * Unit tests for `PrismaTurnRepository`.
 *
 * Layer: unit.
 * Goal: `create` starts a turn QUEUED; `setStatus` stamps `startedAt` only on PREPARING and only
 * via the guarded `updateMany` (never touching an already-set `startedAt`), applies each optional
 * field only when present, redacts a non-null `error` and passes a null `error` through unchanged;
 * `finish` sets usage/finishedAt, redacts `error` only when provided, and names the live statuses
 * in its own `where` so a row that already carries an outcome is not overwritten; `requeue` moves a
 * FAILED turn back to QUEUED through a conditional `updateMany` and answers null when nothing
 * matched; failures translate through `translatePrismaError`. What those conditions produce against
 * a real database is pinned by the shared contract, which no client double can settle.
 * Mocks: a Prisma client double exposing only `turn.*` — no database.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Redactor } from '../../secrets/types.ts';
import { LIVE_RUN_STATUSES } from '../../workspace/lifecycle.ts';
import type { PrismaClient } from '../generated/client.ts';

import { NotFoundError } from './errors.ts';
import { PrismaTurnRepository } from './turn.repository.ts';

/** Builds a P2025 (record not found) error shaped like `PrismaClientKnownRequestError`. */
function p2025(): Error & { code: string } {
  return Object.assign(new Error('Record not found'), { code: 'P2025' });
}

const NOW = new Date('2026-01-01T00:00:00.000Z');

const turnRow = {
  id: 'turn-1',
  chatId: 'chat-1',
  workspaceId: null,
  status: 'QUEUED',
  model: 'gpt-5.6-sol',
  queueJobId: null,
  inputTokens: null,
  outputTokens: null,
  stepCount: 0,
  error: null,
  queuedAt: NOW,
  startedAt: null,
  finishedAt: null,
};

const fakeRedactor: Redactor = {
  register: vi.fn(),
  redact: vi.fn((value: string) => `[REDACTED:${value}]`),
  redactJson: vi.fn((value: unknown) => value),
};

function fakePrisma(
  overrides: {
    create?: ReturnType<typeof vi.fn>;
    updateMany?: ReturnType<typeof vi.fn>;
    updateManyAndReturn?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const turn = {
    create: overrides.create ?? vi.fn(() => Promise.resolve(turnRow)),
    findUnique: vi.fn(() => Promise.resolve(turnRow)),
    findMany: vi.fn(() => Promise.resolve([turnRow])),
    updateMany: overrides.updateMany ?? vi.fn(() => Promise.resolve({ count: 1 })),
    updateManyAndReturn: overrides.updateManyAndReturn ?? vi.fn(() => Promise.resolve([turnRow])),
    update: overrides.update ?? vi.fn(() => Promise.resolve(turnRow)),
  };
  // `setStatus` runs its guarded timestamp write and its status update inside one
  // interactive transaction; the double runs the callback against the same `turn`
  // stub, so the assertions below still see every call the repository makes.
  const client = {
    turn,
    $transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ turn }),
  } as unknown as PrismaClient;
  return { client, turn };
}

describe('PrismaTurnRepository', () => {
  /** create() starts a QUEUED turn, defaulting queueJobId to null. */
  it('create() inserts a QUEUED turn', async () => {
    const { client, turn } = fakePrisma();
    const repo = new PrismaTurnRepository(client, fakeRedactor);
    await repo.create({ chatId: 'chat-1', model: 'gpt-5.6-sol' });
    expect(turn.create).toHaveBeenCalledWith({
      data: { chatId: 'chat-1', model: 'gpt-5.6-sol', queueJobId: null, status: 'QUEUED' },
    });
  });

  /** A missing chat surfaces from Postgres as P2003, translated to NotFoundError('Chat', id). */
  it('create() translates a missing chat to NotFoundError naming the chat', async () => {
    const p2003 = Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' });
    const { client } = fakePrisma({ create: vi.fn(() => Promise.reject(p2003)) });
    const repo = new PrismaTurnRepository(client, fakeRedactor);
    let caught: unknown;
    try {
      await repo.create({ chatId: 'missing-chat', model: 'gpt-5.6-sol' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect((caught as NotFoundError).entity).toBe('Chat');
    expect((caught as NotFoundError).id).toBe('missing-chat');
  });

  /** get() maps a found row and returns null when absent. */
  it('get() returns the mapped turn or null', async () => {
    const { client } = fakePrisma();
    const repo = new PrismaTurnRepository(client, fakeRedactor);
    expect((await repo.get('turn-1'))?.id).toBe('turn-1');
    const { client: emptyClient } = fakePrisma();
    (emptyClient.turn as unknown as { findUnique: ReturnType<typeof vi.fn> }).findUnique = vi.fn(
      () => Promise.resolve(null),
    );
    const repo2 = new PrismaTurnRepository(emptyClient, fakeRedactor);
    expect(await repo2.get('missing')).toBeNull();
  });

  /** PREPARING guards startedAt with updateMany before the main update. */
  it('setStatus(PREPARING) stamps startedAt via a guarded updateMany', async () => {
    const { client, turn } = fakePrisma();
    const repo = new PrismaTurnRepository(client, fakeRedactor);
    await repo.setStatus('turn-1', 'PREPARING');
    expect(turn.updateMany).toHaveBeenCalledWith({
      where: { id: 'turn-1', startedAt: null },
      data: { startedAt: expect.any(Date) as Date },
    });
    expect(turn.update).toHaveBeenCalledWith({
      where: { id: 'turn-1' },
      data: { status: 'PREPARING' },
    });
  });

  /** Any other status never touches startedAt at all. */
  it('setStatus(RUNNING) does not call updateMany', async () => {
    const { client, turn } = fakePrisma();
    const repo = new PrismaTurnRepository(client, fakeRedactor);
    await repo.setStatus('turn-1', 'RUNNING');
    expect(turn.updateMany).not.toHaveBeenCalled();
    expect(turn.update).toHaveBeenCalledWith({
      where: { id: 'turn-1' },
      data: { status: 'RUNNING' },
    });
  });

  /** workspaceId/queueJobId apply only when present in the update object. */
  it('setStatus() applies workspaceId and queueJobId only when present', async () => {
    const { client, turn } = fakePrisma();
    const repo = new PrismaTurnRepository(client, fakeRedactor);
    await repo.setStatus('turn-1', 'RUNNING', { workspaceId: 'ws-1', queueJobId: 'job-1' });
    expect(turn.update).toHaveBeenCalledWith({
      where: { id: 'turn-1' },
      data: { status: 'RUNNING', workspaceId: 'ws-1', queueJobId: 'job-1' },
    });
  });

  /** A non-null error is redacted; a null error clears the column without redaction. */
  it('setStatus() redacts a non-null error and passes null through unchanged', async () => {
    const { client, turn } = fakePrisma();
    const repo = new PrismaTurnRepository(client, fakeRedactor);
    await repo.setStatus('turn-1', 'FAILED', { error: 'boom' });
    expect(turn.update).toHaveBeenLastCalledWith({
      where: { id: 'turn-1' },
      data: { status: 'FAILED', error: '[REDACTED:boom]' },
    });
    await repo.setStatus('turn-1', 'FAILED', { error: null });
    expect(turn.update).toHaveBeenLastCalledWith({
      where: { id: 'turn-1' },
      data: { status: 'FAILED', error: null },
    });
  });

  /** A failure inside setStatus (missing row) translates through translatePrismaError. */
  it('setStatus() translates a missing row to NotFoundError', async () => {
    const { client } = fakePrisma({ update: vi.fn(() => Promise.reject(p2025())) });
    const repo = new PrismaTurnRepository(client, fakeRedactor);
    await expect(repo.setStatus('missing', 'RUNNING')).rejects.toBeInstanceOf(NotFoundError);
  });

  /**
   * finish() sets usage, finishedAt and status; error omitted leaves the column untouched. The
   * live statuses travel in the `where`, which is what makes the write conditional: an `update`
   * by id would satisfy every other assertion here and still overwrite an outcome somebody else
   * had already recorded.
   */
  it('finish() sets usage and finishedAt without an error field when omitted', async () => {
    const { client, turn } = fakePrisma();
    const repo = new PrismaTurnRepository(client, fakeRedactor);
    await repo.finish('turn-1', 'SUCCEEDED', { inputTokens: 1, outputTokens: 2, stepCount: 3 });
    expect(turn.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: 'turn-1', status: { in: [...LIVE_RUN_STATUSES] } },
      data: {
        status: 'SUCCEEDED',
        inputTokens: 1,
        outputTokens: 2,
        stepCount: 3,
        finishedAt: expect.any(Date) as Date,
      },
    });
  });

  /** finish() redacts the error when provided. */
  it('finish() redacts the error when provided', async () => {
    const { client, turn } = fakePrisma();
    const repo = new PrismaTurnRepository(client, fakeRedactor);
    await repo.finish(
      'turn-1',
      'FAILED',
      { inputTokens: 0, outputTokens: 0, stepCount: 1 },
      'boom',
    );
    expect(turn.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: 'turn-1', status: { in: [...LIVE_RUN_STATUSES] } },
      data: {
        status: 'FAILED',
        inputTokens: 0,
        outputTokens: 0,
        stepCount: 1,
        finishedAt: expect.any(Date) as Date,
        error: '[REDACTED:boom]',
      },
    });
  });

  /**
   * Nothing matched, so nothing was recorded and the caller is told so. It is answered rather than
   * thrown because losing a race is an outcome the caller has to handle, not a fault: the same
   * reasoning `requeue` already followed.
   */
  it('finish() answers null when no live row matched', async () => {
    const { client } = fakePrisma({ updateManyAndReturn: vi.fn(() => Promise.resolve([])) });
    const repo = new PrismaTurnRepository(client, fakeRedactor);
    expect(
      await repo.finish('missing', 'SUCCEEDED', {
        inputTokens: 0,
        outputTokens: 0,
        stepCount: 0,
      }),
    ).toBeNull();
  });

  /**
   * requeue() names FAILED in the `where` clause, so Postgres and not the caller decides whether
   * the transition is legal, and it clears every field the failed attempt left behind — an error
   * still on the row would be rendered under a turn that is queued again.
   */
  it('requeue() moves a FAILED turn back to QUEUED and clears the failed attempt', async () => {
    const { client, turn } = fakePrisma();
    const repo = new PrismaTurnRepository(client, fakeRedactor);

    const requeued = await repo.requeue('turn-1');

    expect(turn.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: 'turn-1', status: 'FAILED' },
      data: {
        status: 'QUEUED',
        error: null,
        startedAt: null,
        finishedAt: null,
        inputTokens: null,
        outputTokens: null,
        stepCount: 0,
        preparedBranch: null,
        preparedSha: null,
      },
    });
    // The row comes back from the statement that wrote it, so nothing re-reads it: a second round
    // trip could answer `null` for a turn this call had genuinely requeued, once a cascade removed
    // it in between.
    expect(turn.findUnique).not.toHaveBeenCalled();
    expect(requeued?.id).toBe('turn-1');
  });

  /**
   * A row the conditional update did not match answers `null` rather than raising: "this turn is
   * not retryable" is an ordinary answer the route turns into a 409, not a failure of the store.
   */
  it('requeue() answers null when no row matched the FAILED condition', async () => {
    const { client, turn } = fakePrisma({
      updateManyAndReturn: vi.fn(() => Promise.resolve([])),
    });
    const repo = new PrismaTurnRepository(client, fakeRedactor);

    expect(await repo.requeue('turn-1')).toBeNull();
    expect(turn.findUnique).not.toHaveBeenCalled();
  });

  /**
   * `recordPrepared` addresses the row by id through `updateMany`, so a turn deleted with its chat
   * while the runtime was still cloning matches nothing instead of raising P2025 under the
   * processor. The preparation is the one part of a workspace's setup that outlives it, because
   * the transcript states it again after a reload and the event itself is not kept.
   */
  it('recordPrepared() writes the branch and commit without failing on a missing row', async () => {
    const { client, turn } = fakePrisma();
    const repo = new PrismaTurnRepository(client, fakeRedactor);

    await repo.recordPrepared('turn-1', { branch: 'agent/018f3a2b', headSha: 'abc1234def' });

    expect(turn.updateMany).toHaveBeenCalledWith({
      where: { id: 'turn-1' },
      data: { preparedBranch: 'agent/018f3a2b', preparedSha: 'abc1234def' },
    });
    expect(turn.update).not.toHaveBeenCalled();
  });

  /** listByChat() orders by queuedAt asc. */
  it('listByChat() orders by queuedAt asc', async () => {
    const { client, turn } = fakePrisma();
    const repo = new PrismaTurnRepository(client, fakeRedactor);
    await repo.listByChat('chat-1');
    expect(turn.findMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      orderBy: { queuedAt: 'asc' },
    });
  });
});
