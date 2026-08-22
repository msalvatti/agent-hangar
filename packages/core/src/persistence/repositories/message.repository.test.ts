/**
 * Unit tests for `PrismaMessageRepository`.
 *
 * Layer: unit.
 * Goal: `append` locks the parent chat, computes the next `seq` (handling both `number` and
 * `bigint` aggregate results, and the "no prior message" case), redacts `content`, and throws
 * `NotFoundError` for a missing chat without ever calling `message.create`; `listByChat` builds
 * the right `where`/`orderBy`/`take` for every combination of `limit`/`before` and reverses the
 * descending query back to ascending order.
 * Mocks: a Prisma client double with `$transaction` and `message.findMany` — no database.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Redactor } from '../../secrets/types.ts';
import type { PrismaClient } from '../generated/client.ts';

import { NotFoundError } from './errors.ts';
import { PrismaMessageRepository } from './message.repository.ts';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const fakeRedactor: Redactor = {
  register: vi.fn(),
  redact: vi.fn((value: string) => value.replaceAll('SECRET', '[REDACTED]')),
  redactJson: vi.fn((value: unknown) => value),
};

/** Builds a fake `tx` (transaction client) with scripted `$queryRaw` results for lock + next-seq. */
function fakeTx(options: { locked: { id: string }[]; next: { next: number | bigint }[] }) {
  const create = vi.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: 'msg-1',
      chatId: args.data.chatId as string,
      turnId: (args.data.turnId as string | null) ?? null,
      seq: args.data.seq as number,
      role: args.data.role as string,
      content: args.data.content as string,
      createdAt: NOW,
    }),
  );
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce(options.locked)
    .mockResolvedValueOnce(options.next);
  return { tx: { $queryRaw: queryRaw, message: { create } }, create, queryRaw };
}

/** Wires `$transaction` to invoke the callback with the given `tx`. */
function fakePrismaWithTx(tx: unknown) {
  const transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(tx));
  return { $transaction: transaction } as unknown as PrismaClient;
}

describe('PrismaMessageRepository', () => {
  /** The first message of a chat gets seq 1. */
  it('append() assigns seq 1 for the first message of a chat and redacts content', async () => {
    const { tx, create } = fakeTx({ locked: [{ id: 'chat-1' }], next: [{ next: 1 }] });
    const prisma = fakePrismaWithTx(tx);
    const repo = new PrismaMessageRepository(prisma, fakeRedactor);
    const message = await repo.append('chat-1', 'USER', 'hello SECRET', undefined);
    expect(message.seq).toBe(1);
    expect(create).toHaveBeenCalledWith({
      data: { chatId: 'chat-1', seq: 1, role: 'USER', content: 'hello [REDACTED]', turnId: null },
    });
  });

  /** A bigint aggregate result (some drivers) converts to a plain number. */
  it('append() converts a bigint next-seq result to a number', async () => {
    const { tx } = fakeTx({ locked: [{ id: 'chat-1' }], next: [{ next: 4n }] });
    const prisma = fakePrismaWithTx(tx);
    const repo = new PrismaMessageRepository(prisma, fakeRedactor);
    const message = await repo.append('chat-1', 'ASSISTANT', 'hi', 'turn-1');
    expect(message.seq).toBe(4);
    expect(typeof message.seq).toBe('number');
  });

  /** An empty aggregate result row (defensive) falls back to seq 1. */
  it('append() defaults to seq 1 when the aggregate returns no row', async () => {
    const { tx } = fakeTx({ locked: [{ id: 'chat-1' }], next: [] });
    const prisma = fakePrismaWithTx(tx);
    const repo = new PrismaMessageRepository(prisma, fakeRedactor);
    const message = await repo.append('chat-1', 'USER', 'hi');
    expect(message.seq).toBe(1);
  });

  /** Appending to a chat that does not exist throws NotFoundError before any insert. */
  it('append() throws NotFoundError for a missing chat without inserting', async () => {
    const { tx, create } = fakeTx({ locked: [], next: [] });
    const prisma = fakePrismaWithTx(tx);
    const repo = new PrismaMessageRepository(prisma, fakeRedactor);
    await expect(repo.append('missing', 'USER', 'hi')).rejects.toBeInstanceOf(NotFoundError);
    expect(create).not.toHaveBeenCalled();
  });

  /** A minimal but complete Message row, so `toMessage` never hits an undefined field. */
  function messageRow(seq: number): {
    id: string;
    chatId: string;
    turnId: string | null;
    seq: number;
    role: string;
    content: string;
    createdAt: Date;
  } {
    return {
      id: `m${String(seq)}`,
      chatId: 'chat-1',
      turnId: null,
      seq,
      role: 'USER',
      content: 'hi',
      createdAt: NOW,
    };
  }

  /** listByChat() without options fetches everything descending, then reverses to ascending. */
  function fakeMessageFindMany(rows: ReturnType<typeof messageRow>[]) {
    const findMany = vi.fn(() => Promise.resolve(rows));
    const prisma = { message: { findMany } } as unknown as PrismaClient;
    return { prisma, findMany };
  }

  it('listByChat() without options queries desc and returns ascending', async () => {
    const { prisma, findMany } = fakeMessageFindMany([messageRow(2), messageRow(1)]);
    const repo = new PrismaMessageRepository(prisma, fakeRedactor);
    const result = await repo.listByChat('chat-1');
    expect(findMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      orderBy: { seq: 'desc' },
    });
    expect(result.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('listByChat({ before }) adds a seq < before filter', async () => {
    const { prisma, findMany } = fakeMessageFindMany([messageRow(1)]);
    const repo = new PrismaMessageRepository(prisma, fakeRedactor);
    await repo.listByChat('chat-1', { before: 3 });
    expect(findMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', seq: { lt: 3 } },
      orderBy: { seq: 'desc' },
    });
  });

  it('listByChat({ limit }) adds a take clause', async () => {
    const { prisma, findMany } = fakeMessageFindMany([messageRow(1)]);
    const repo = new PrismaMessageRepository(prisma, fakeRedactor);
    await repo.listByChat('chat-1', { limit: 2 });
    expect(findMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      orderBy: { seq: 'desc' },
      take: 2,
    });
  });

  it('listByChat({ before, limit }) combines both', async () => {
    const { prisma, findMany } = fakeMessageFindMany([messageRow(2)]);
    const repo = new PrismaMessageRepository(prisma, fakeRedactor);
    await repo.listByChat('chat-1', { before: 3, limit: 1 });
    expect(findMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', seq: { lt: 3 } },
      orderBy: { seq: 'desc' },
      take: 1,
    });
  });
});

describe('what the message repository asks the database for', () => {
  /**
   * The two raw statements are the whole of the sequencing guarantee: the first takes a row lock on
   * the chat so two appends cannot compute the same number, and the second computes it. Emptied,
   * the first locks nothing — appends race and two messages claim one sequence — and the second
   * answers nothing, so every message is the first.
   */
  it('locks the chat row and computes the next sequence from the messages of that chat', async () => {
    const { tx, queryRaw } = fakeTx({ locked: [{ id: 'chat-1' }], next: [{ next: 4 }] });
    const repo = new PrismaMessageRepository(fakePrismaWithTx(tx), fakeRedactor);

    await repo.append('chat-1', 'USER', 'hello');

    const text = (call: unknown[]): string => (call[0] as string[]).join('?');
    expect(text(queryRaw.mock.calls[0] ?? [])).toBe(
      'SELECT id FROM "Chat" WHERE id = ? FOR UPDATE',
    );
    expect(text(queryRaw.mock.calls[1] ?? [])).toBe(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM "Message" WHERE "chatId" = ?',
    );
  });

  /**
   * The aggregate is over an `Int` column, so Postgres normally answers with a 32-bit integer — but
   * the wire type is a driver detail, and a `bigint` handed on unconverted is a value Prisma will
   * not write into an `Int` column and JSON cannot serialise.
   */
  it('converts a sequence the driver reports as a bigint', async () => {
    const { tx, create } = fakeTx({ locked: [{ id: 'chat-1' }], next: [{ next: 7n }] });
    const repo = new PrismaMessageRepository(fakePrismaWithTx(tx), fakeRedactor);

    await repo.append('chat-1', 'USER', 'hello');

    expect(create.mock.calls[0]?.[0].data.seq).toBe(7);
  });

  /**
   * A listing with no limit asks for no limit. Sent one anyway — of nothing — the page size becomes
   * whatever the driver makes of `undefined`, and a transcript that should show every message shows
   * some other number of them.
   */
  it.each([
    ['no limit', {}, undefined],
    ['the limit it was given', { limit: 25 }, 25],
  ])('asks for %s', async (_case, options, take) => {
    const findMany = vi.fn(() => Promise.resolve([]));
    const repo = new PrismaMessageRepository(
      { message: { findMany } } as unknown as PrismaClient,
      fakeRedactor,
    );

    await repo.listByChat('chat-1', options);

    expect(findMany.mock.calls[0]?.[0]).toStrictEqual({
      where: { chatId: 'chat-1' },
      orderBy: { seq: 'desc' },
      ...(take === undefined ? {} : { take }),
    });
  });

  /**
   * The lock is what proves the chat exists at the moment the sequence is computed; a chat that
   * has gone in between is reported as that chat being missing, not as a message that could not be
   * written.
   */
  it('names the chat when the lock finds no row', async () => {
    const { tx } = fakeTx({ locked: [], next: [{ next: 1 }] });
    const repo = new PrismaMessageRepository(fakePrismaWithTx(tx), fakeRedactor);

    const failure = await repo.append('chat-1', 'USER', 'hello').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotFoundError);
    expect((failure as NotFoundError).entity).toBe('Chat');
  });
});
