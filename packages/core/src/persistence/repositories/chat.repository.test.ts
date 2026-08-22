/**
 * Unit tests for `PrismaChatRepository`.
 *
 * Layer: unit.
 * Goal: every method builds the right Prisma call and maps the result; `updateRestoreHints`
 * changes only the fields explicitly present; every write explicitly bumps `updatedAt` (an
 * update whose `data` has no other key never triggers Prisma's `@updatedAt` directive on its
 * own, which is exactly what `touch` sends); `title` is redacted on `create` and on `rename`,
 * while the identifier columns are written untouched; an `update` failure translates through
 * `translatePrismaError`; and `deleteIfIdle` sends the live-turn condition inside the statement,
 * so nothing decides it in this process. The outcomes that condition produces are pinned against a
 * real database by the shared contract, which no client double can settle.
 * Mocks: a Prisma client double exposing only `chat.*` — no database.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Redactor } from '../../secrets/types.ts';
import { LIVE_RUN_STATUSES } from '../../workspace/lifecycle.ts';
import type { PrismaClient } from '../generated/client.ts';

import { PrismaChatRepository } from './chat.repository.ts';
import { NotFoundError } from './errors.ts';

/** Builds a P2025 (record not found) error shaped like `PrismaClientKnownRequestError`. */
function p2025(message = 'Record not found'): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'P2025' });
}

const NOW = new Date('2026-01-01T00:00:00.000Z');

const fakeRedactor: Redactor = {
  register: vi.fn(),
  redact: vi.fn((value: string) => `[REDACTED:${value}]`),
  redactJson: vi.fn((value: unknown) => value),
};

const chatRow = {
  id: 'chat-1',
  title: 'Fix the bug',
  status: 'ACTIVE',
  repoUrl: 'https://github.com/acme/repo',
  baseBranch: 'main',
  workBranch: null,
  lastPushedSha: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

/** Builds a fake Prisma client exposing only the `chat` delegate methods this repository calls. */
function fakePrisma(
  overrides: Partial<
    Record<'create' | 'findUnique' | 'findMany' | 'update' | 'deleteMany', ReturnType<typeof vi.fn>>
  > = {},
) {
  const chat = {
    create: vi.fn(() => Promise.resolve(chatRow)),
    findUnique: vi.fn(() => Promise.resolve(chatRow)),
    findMany: vi.fn(() => Promise.resolve([chatRow])),
    update: vi.fn(() => Promise.resolve(chatRow)),
    deleteMany: vi.fn(() => Promise.resolve({ count: 1 })),
    ...overrides,
  };
  return { client: { chat } as unknown as PrismaClient, chat };
}

describe('PrismaChatRepository', () => {
  /** create() writes status ACTIVE and maps the returned row. */
  it('create() inserts an ACTIVE chat and returns the mapped row', async () => {
    const { client, chat } = fakePrisma();
    const repo = new PrismaChatRepository(client, fakeRedactor);
    const result = await repo.create({
      title: 'Fix the bug',
      repoUrl: chatRow.repoUrl,
      baseBranch: 'main',
    });
    expect(chat.create).toHaveBeenCalledWith({
      data: {
        title: '[REDACTED:Fix the bug]',
        repoUrl: chatRow.repoUrl,
        baseBranch: 'main',
        status: 'ACTIVE',
      },
    });
    expect(result.id).toBe('chat-1');
  });

  /** getById() maps a found row. */
  it('getById() returns the mapped chat when found', async () => {
    const { client } = fakePrisma();
    const repo = new PrismaChatRepository(client, fakeRedactor);
    const result = await repo.getById('chat-1');
    expect(result?.id).toBe('chat-1');
  });

  /** getById() returns null, never throws, when the row is absent. */
  it('getById() returns null when not found', async () => {
    const { client } = fakePrisma({ findUnique: vi.fn(() => Promise.resolve(null)) });
    const repo = new PrismaChatRepository(client, fakeRedactor);
    expect(await repo.getById('missing')).toBeNull();
  });

  /** list() without a status filters nothing and orders by updatedAt desc. */
  it('list() without a status queries every chat ordered by updatedAt desc', async () => {
    const { client, chat } = fakePrisma();
    const repo = new PrismaChatRepository(client, fakeRedactor);
    await repo.list();
    expect(chat.findMany).toHaveBeenCalledWith({ where: {}, orderBy: { updatedAt: 'desc' } });
  });

  /** list(status) filters by the given status. */
  it('list(status) filters by status', async () => {
    const { client, chat } = fakePrisma();
    const repo = new PrismaChatRepository(client, fakeRedactor);
    await repo.list('ARCHIVED');
    expect(chat.findMany).toHaveBeenCalledWith({
      where: { status: 'ARCHIVED' },
      orderBy: { updatedAt: 'desc' },
    });
  });

  /** rename() updates only the title, redacted like the one create() writes. */
  it('rename() updates the title, redacted', async () => {
    const { client, chat } = fakePrisma();
    const repo = new PrismaChatRepository(client, fakeRedactor);
    await repo.rename('chat-1', 'New title');
    expect(chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      data: { title: '[REDACTED:New title]', updatedAt: expect.any(Date) as Date },
    });
  });

  /**
   * The identifier columns must stay verbatim: redacting a branch name or a commit sha would
   * corrupt data `git` is handed, and the lane rule forbids redacting identifiers.
   */
  it('updateRestoreHints() writes the identifier columns untouched', async () => {
    const { client, chat } = fakePrisma();
    const repo = new PrismaChatRepository(client, fakeRedactor);
    await repo.updateRestoreHints('chat-1', {
      workBranch: 'agent/abc123',
      lastPushedSha: 'deadbeef',
    });
    expect(chat.update).toHaveBeenLastCalledWith({
      where: { id: 'chat-1' },
      data: {
        workBranch: 'agent/abc123',
        lastPushedSha: 'deadbeef',
        updatedAt: expect.any(Date) as Date,
      },
    });
  });

  /** setStatus('ARCHIVED') stamps archivedAt; setStatus('ACTIVE') clears it. */
  it('setStatus() stamps archivedAt for ARCHIVED and clears it for ACTIVE', async () => {
    const { client, chat } = fakePrisma();
    const repo = new PrismaChatRepository(client, fakeRedactor);
    await repo.setStatus('chat-1', 'ARCHIVED');
    expect(chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      data: {
        status: 'ARCHIVED',
        archivedAt: expect.any(Date) as Date,
        updatedAt: expect.any(Date) as Date,
      },
    });
    await repo.setStatus('chat-1', 'ACTIVE');
    expect(chat.update).toHaveBeenLastCalledWith({
      where: { id: 'chat-1' },
      data: { status: 'ACTIVE', archivedAt: null, updatedAt: expect.any(Date) as Date },
    });
  });

  /** updateRestoreHints() changes only the fields explicitly present, both present. */
  it('updateRestoreHints() sets both fields when both are present', async () => {
    const { client, chat } = fakePrisma();
    const repo = new PrismaChatRepository(client, fakeRedactor);
    await repo.updateRestoreHints('chat-1', { workBranch: 'agent/1', lastPushedSha: 'sha1' });
    expect(chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      data: { workBranch: 'agent/1', lastPushedSha: 'sha1', updatedAt: expect.any(Date) as Date },
    });
  });

  /** updateRestoreHints() with only one field present leaves the other untouched. */
  it('updateRestoreHints() sets only the field present in the input', async () => {
    const { client, chat } = fakePrisma();
    const repo = new PrismaChatRepository(client, fakeRedactor);
    await repo.updateRestoreHints('chat-1', { lastPushedSha: 'sha1' });
    expect(chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      data: { lastPushedSha: 'sha1', updatedAt: expect.any(Date) as Date },
    });
  });

  /** updateRestoreHints() can null out a hint. */
  it('updateRestoreHints() can set a field to null', async () => {
    const { client, chat } = fakePrisma();
    const repo = new PrismaChatRepository(client, fakeRedactor);
    await repo.updateRestoreHints('chat-1', { workBranch: null });
    expect(chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      data: { workBranch: null, updatedAt: expect.any(Date) as Date },
    });
  });

  /** touch() sends only an explicit updatedAt bump: an empty Prisma patch never triggers `@updatedAt`. */
  it('touch() sends only an explicit updatedAt bump', async () => {
    const { client, chat } = fakePrisma();
    const repo = new PrismaChatRepository(client, fakeRedactor);
    await repo.touch('chat-1');
    expect(chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      data: { updatedAt: expect.any(Date) as Date },
    });
  });

  /**
   * The condition travels in the `WHERE` of the delete itself. A `delete` by id with the turns
   * read beforehand would pass this suite just as well and still lose the race the method exists
   * to settle, so what is asserted is the shape of the statement, not just its effect.
   */
  it('deleteIfIdle() names the live-turn condition inside the delete', async () => {
    const { client, chat } = fakePrisma();
    const repo = new PrismaChatRepository(client, fakeRedactor);
    expect(await repo.deleteIfIdle('chat-1')).toBe('DELETED');
    expect(chat.deleteMany).toHaveBeenCalledWith({
      where: { id: 'chat-1', turns: { none: { status: { in: [...LIVE_RUN_STATUSES] } } } },
    });
    expect(chat.findUnique).not.toHaveBeenCalled();
  });

  /**
   * Nothing matched, so the second read decides which of the two reasons it was; a row that is
   * still there was held by a live turn, and one that is not is simply gone.
   */
  it('deleteIfIdle() tells a chat held by a turn apart from one that is gone', async () => {
    const held = fakePrisma({ deleteMany: vi.fn(() => Promise.resolve({ count: 0 })) });
    expect(await new PrismaChatRepository(held.client, fakeRedactor).deleteIfIdle('chat-1')).toBe(
      'LIVE_TURN',
    );

    const gone = fakePrisma({
      deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
      findUnique: vi.fn(() => Promise.resolve(null)),
    });
    expect(await new PrismaChatRepository(gone.client, fakeRedactor).deleteIfIdle('chat-1')).toBe(
      'MISSING',
    );
  });

  /** update() on a missing row (via rename) also translates P2025. */
  it('rename() translates a missing row to NotFoundError', async () => {
    const { client } = fakePrisma({ update: vi.fn(() => Promise.reject(p2025())) });
    const repo = new PrismaChatRepository(client, fakeRedactor);
    await expect(repo.rename('missing', 'x')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('what the chat repository asks the database for', () => {
  /**
   * A chat read by id is read by id: without the filter the query answers with whichever row the
   * database returns first, so a caller asking about one chat is shown another's title, branch and
   * history.
   */
  it('reads one chat by its id', async () => {
    const { client, chat } = fakePrisma();
    const repo = new PrismaChatRepository(client, fakeRedactor);

    await repo.getById('chat-1');

    expect(chat.findUnique.mock.calls).toStrictEqual([[{ where: { id: 'chat-1' } }]]);
  });

  /**
   * Telling a delete apart from a live turn means asking whether the row is still there, by id and
   * for nothing but its id: the answer decides between "already gone" and "still working", and
   * either read without its filter answers about some other chat entirely.
   */
  it('checks whether the chat is still there by id alone', async () => {
    const { client, chat } = fakePrisma({ deleteMany: vi.fn(() => Promise.resolve({ count: 0 })) });
    const repo = new PrismaChatRepository(client, fakeRedactor);

    await expect(repo.deleteIfIdle('chat-1')).resolves.toBe('LIVE_TURN');
    expect(chat.findUnique.mock.calls).toStrictEqual([
      [{ where: { id: 'chat-1' }, select: { id: true } }],
    ]);
  });

  /**
   * Restore hints are a partial patch: a turn that learned only the branch must not blank the sha
   * it never mentioned. Written with every key present, an absent hint becomes an explicit
   * `undefined` — which today means "leave alone" and which nothing here would notice changing.
   */
  it.each([
    ['only the branch', { workBranch: 'agent/x' }, { workBranch: 'agent/x' }],
    ['only the sha', { lastPushedSha: 'abc' }, { lastPushedSha: 'abc' }],
  ])('writes %s when that is all the turn learned', async (_case, hints, written) => {
    const { client, chat } = fakePrisma();
    const repo = new PrismaChatRepository(client, fakeRedactor);

    await repo.updateRestoreHints('chat-1', hints);

    expect(chat.update.mock.calls).toStrictEqual([
      [{ where: { id: 'chat-1' }, data: { ...written, updatedAt: expect.any(Date) as Date } }],
    ]);
  });

  /** Every write of this repository reports which entity was missing when the row has gone. */
  it('names the entity of a row it could not update', async () => {
    const { client } = fakePrisma({ update: vi.fn(() => Promise.reject(p2025())) });
    const repo = new PrismaChatRepository(client, fakeRedactor);

    const failure = await repo.rename('chat-1', 'new title').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotFoundError);
    expect((failure as NotFoundError).entity).toBe('Chat');
  });
});
