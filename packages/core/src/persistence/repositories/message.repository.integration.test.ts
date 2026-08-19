/**
 * `@db` integration suite for `PrismaMessageRepository`, against a real Postgres.
 *
 * Layer: integration.
 * Goal: `append` assigns a gap-free `seq` even under concurrency (20 parallel appends to the same
 * chat), throws `NotFoundError` for a missing chat without writing a row, and redacts `content`
 * before the write (asserted with a raw column read, bypassing the mapper); `listByChat` honours
 * `before`/`limit`; a message's `turnId` becomes `null` when its turn is deleted (SetNull).
 * Mocks: none — a real compose Postgres.
 */
import { beforeEach, expect, it } from 'vitest';

import type { Redactor } from '../../secrets/types.js';
import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '../../testing/canaries.js';
import type { PrismaClient } from '../generated/client.js';
import {
  connectTestDb,
  describeDb,
  rawSelect,
  seedChat,
  sqlTemplate,
  truncateAll,
} from '../testing/db.js';

import { NotFoundError } from './errors.js';
import { PrismaMessageRepository } from './message.repository.js';

/** Redacts the two canaries exactly, mirroring the shape a real Redactor implements. */
const testRedactor: Redactor = {
  register: () => undefined,
  redact: (input: string) =>
    input.replaceAll(GITHUB_CANARY, '[REDACTED]').replaceAll(OPENAI_CANARY, '[REDACTED]'),
  redactJson: (input: unknown) => input,
};

let client: PrismaClient;

describeDb('PrismaMessageRepository', () => {
  beforeEach(async () => {
    client = connectTestDb();
    await truncateAll(client);
  });

  /** Sequential appends get 1, 2, 3 in order, and listByChat returns them ascending. */
  it('append() assigns gap-free seq and listByChat() returns ascending order', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaMessageRepository(client, testRedactor);
    await repo.append(chatId, 'USER', 'one');
    await repo.append(chatId, 'ASSISTANT', 'two');
    await repo.append(chatId, 'USER', 'three');
    const messages = await repo.listByChat(chatId);
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(messages.map((m) => m.content)).toEqual(['one', 'two', 'three']);
  });

  /** limit returns the latest N; before filters strictly less than the cursor; both combine. */
  it('listByChat() honours limit, before, and both together', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaMessageRepository(client, testRedactor);
    await repo.append(chatId, 'USER', 'one');
    await repo.append(chatId, 'USER', 'two');
    await repo.append(chatId, 'USER', 'three');
    expect((await repo.listByChat(chatId, { limit: 2 })).map((m) => m.seq)).toEqual([2, 3]);
    expect((await repo.listByChat(chatId, { before: 3 })).map((m) => m.seq)).toEqual([1, 2]);
    expect((await repo.listByChat(chatId, { before: 3, limit: 1 })).map((m) => m.seq)).toEqual([2]);
  });

  /** The critical invariant: 20 concurrent appends to one chat never collide or leave a gap. */
  it('append() stays gap-free under 20 concurrent writers on the same chat', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaMessageRepository(client, testRedactor);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => repo.append(chatId, 'USER', `msg-${String(i)}`)),
    );
    const seqs = results.map((m) => m.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  /** A second chat keeps its own independent sequence. */
  it('append() gives each chat its own independent sequence', async () => {
    const chatA = await seedChat(client);
    const chatB = await seedChat(client);
    const repo = new PrismaMessageRepository(client, testRedactor);
    await repo.append(chatA, 'USER', 'a1');
    const first = await repo.append(chatB, 'USER', 'b1');
    expect(first.seq).toBe(1);
  });

  /** Appending to a chat that does not exist throws and writes no row. */
  it('append() throws NotFoundError for a missing chat and writes nothing', async () => {
    const repo = new PrismaMessageRepository(client, testRedactor);
    await expect(repo.append('missing-chat', 'USER', 'hi')).rejects.toBeInstanceOf(NotFoundError);
    expect(await client.message.count()).toBe(0);
  });

  /** Content containing canaries is stored redacted, verified by reading the raw column. */
  it('append() redacts canaries before the write', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaMessageRepository(client, testRedactor);
    const message = await repo.append(
      chatId,
      'USER',
      `token ${GITHUB_CANARY} and ${OPENAI_CANARY}`,
    );
    const rows = await rawSelect<{ content: string }>(
      client,
      sqlTemplate('SELECT content FROM "Message" WHERE id = '),
      message.id,
    );
    const content = rows[0]?.content ?? '';
    expect(content).toContain('[REDACTED]');
    assertNoCanary(content);
  });

  /** A message's turnId becomes null (SetNull) once its turn is deleted. */
  it('turnId becomes null once the owning turn is deleted', async () => {
    const chatId = await seedChat(client);
    const turn = await client.turn.create({ data: { chatId, model: 'gpt-5.6-sol' } });
    const repo = new PrismaMessageRepository(client, testRedactor);
    const message = await repo.append(chatId, 'ASSISTANT', 'from a turn', turn.id);
    expect(message.turnId).toBe(turn.id);
    await client.turn.delete({ where: { id: turn.id } });
    const [reloaded] = await repo.listByChat(chatId);
    expect(reloaded?.turnId).toBeNull();
  });
});
