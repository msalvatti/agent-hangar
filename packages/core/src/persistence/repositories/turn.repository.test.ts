/**
 * Unit tests for `PrismaTurnRepository`.
 *
 * Layer: unit.
 * Goal: `create` starts a turn QUEUED; `setStatus` stamps `startedAt` only on PREPARING and only
 * via the guarded `updateMany` (never touching an already-set `startedAt`), applies each optional
 * field only when present, redacts a non-null `error` and passes a null `error` through unchanged;
 * `finish` sets usage/finishedAt and redacts `error` only when provided; failures translate
 * through `translatePrismaError`.
 * Mocks: a Prisma client double exposing only `turn.*` — no database.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Redactor } from '../../secrets/types.js';
import type { PrismaClient } from '../generated/client.js';

import { NotFoundError } from './errors.js';
import { PrismaTurnRepository } from './turn.repository.js';

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
    update?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const turn = {
    create: overrides.create ?? vi.fn(() => Promise.resolve(turnRow)),
    findUnique: vi.fn(() => Promise.resolve(turnRow)),
    findMany: vi.fn(() => Promise.resolve([turnRow])),
    updateMany: overrides.updateMany ?? vi.fn(() => Promise.resolve({ count: 1 })),
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

  /** finish() sets usage, finishedAt and status; error omitted leaves the column untouched. */
  it('finish() sets usage and finishedAt without an error field when omitted', async () => {
    const { client, turn } = fakePrisma();
    const repo = new PrismaTurnRepository(client, fakeRedactor);
    await repo.finish('turn-1', 'SUCCEEDED', { inputTokens: 1, outputTokens: 2, stepCount: 3 });
    expect(turn.update).toHaveBeenCalledWith({
      where: { id: 'turn-1' },
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
    expect(turn.update).toHaveBeenCalledWith({
      where: { id: 'turn-1' },
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

  /** A failure inside finish() also translates through translatePrismaError. */
  it('finish() translates a missing row to NotFoundError', async () => {
    const { client } = fakePrisma({ update: vi.fn(() => Promise.reject(p2025())) });
    const repo = new PrismaTurnRepository(client, fakeRedactor);
    await expect(
      repo.finish('missing', 'SUCCEEDED', { inputTokens: 0, outputTokens: 0, stepCount: 0 }),
    ).rejects.toBeInstanceOf(NotFoundError);
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
