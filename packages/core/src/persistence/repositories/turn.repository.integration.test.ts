/**
 * `@db` integration suite for `PrismaTurnRepository`, against a real Postgres.
 *
 * Layer: integration.
 * Goal: `create` starts QUEUED with `stepCount` 0; `setStatus('PREPARING')` stamps `startedAt`
 * once, and a later `RUNNING` never overwrites it; `finish` sets usage/`finishedAt` and redacts a
 * canary in `error` before the write; `listByChat` orders by `queuedAt` asc; unknown ids resolve
 * per the port (`get` → null, `setStatus` → `NotFoundError`, `create` on a missing chat →
 * `NotFoundError('Chat', …)`); a `setStatus` whose status update fails rolls the `startedAt` stamp
 * back with it.
 * Mocks: none — a real compose Postgres.
 */
import { beforeEach, expect, it } from 'vitest';

import type { Redactor } from '../../secrets/types.js';
import { GITHUB_CANARY } from '../../testing/canaries.js';
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
import { PrismaTurnRepository } from './turn.repository.js';

const testRedactor: Redactor = {
  register: () => undefined,
  redact: (input: string) => input.replaceAll(GITHUB_CANARY, '[REDACTED]'),
  redactJson: (input: unknown) => input,
};

let client: PrismaClient;

describeDb('PrismaTurnRepository', () => {
  beforeEach(async () => {
    client = connectTestDb();
    await truncateAll(client);
  });

  /** create() starts QUEUED with a zero stepCount. */
  it('create() starts QUEUED with stepCount 0', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaTurnRepository(client, testRedactor);
    const turn = await repo.create({ chatId, model: 'gpt-5.6-sol' });
    expect(turn.status).toBe('QUEUED');
    expect(turn.stepCount).toBe(0);
    expect(turn.startedAt).toBeNull();
  });

  /** A turn whose chat does not exist is a foreign-key violation, reported as NotFoundError. */
  it('create() on a missing chat throws NotFoundError naming the chat', async () => {
    const repo = new PrismaTurnRepository(client, testRedactor);
    let caught: unknown;
    try {
      await repo.create({ chatId: 'no-such-chat', model: 'gpt-5.6-sol' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect((caught as NotFoundError).entity).toBe('Chat');
    expect((caught as NotFoundError).id).toBe('no-such-chat');
  });

  /**
   * The guarded `startedAt` stamp and the status update share one transaction, so a PREPARING
   * that fails on an unknown `workspaceId` must leave the turn QUEUED with `startedAt` still null
   * rather than a QUEUED turn that looks started.
   */
  it('setStatus() rolls the startedAt stamp back when the status update fails', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaTurnRepository(client, testRedactor);
    const turn = await repo.create({ chatId, model: 'gpt-5.6-sol' });
    await expect(
      repo.setStatus(turn.id, 'PREPARING', { workspaceId: 'no-such-workspace' }),
    ).rejects.toThrow();
    const rows = await rawSelect<{ startedAt: Date | null; status: string }>(
      client,
      sqlTemplate('SELECT "startedAt", status FROM "Turn" WHERE id = '),
      turn.id,
    );
    expect(rows[0]?.startedAt).toBeNull();
    expect(rows[0]?.status).toBe('QUEUED');
  });

  /** PREPARING stamps startedAt once; a later RUNNING never overwrites it. */
  it('setStatus(PREPARING) stamps startedAt once and RUNNING keeps it', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaTurnRepository(client, testRedactor);
    const turn = await repo.create({ chatId, model: 'gpt-5.6-sol' });
    const prepared = await repo.setStatus(turn.id, 'PREPARING');
    expect(prepared.startedAt).not.toBeNull();
    const running = await repo.setStatus(turn.id, 'RUNNING');
    expect(running.startedAt?.getTime()).toBe(prepared.startedAt?.getTime());
  });

  /** finish() sets usage, stepCount and finishedAt for a terminal status. */
  it('finish(SUCCEEDED) sets usage, stepCount and finishedAt', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaTurnRepository(client, testRedactor);
    const turn = await repo.create({ chatId, model: 'gpt-5.6-sol' });
    const finished = await repo.finish(turn.id, 'SUCCEEDED', {
      inputTokens: 10,
      outputTokens: 20,
      stepCount: 3,
    });
    expect(finished.status).toBe('SUCCEEDED');
    expect(finished.inputTokens).toBe(10);
    expect(finished.outputTokens).toBe(20);
    expect(finished.stepCount).toBe(3);
    expect(finished.finishedAt).not.toBeNull();
  });

  /** finish(FAILED) with an error containing a canary stores it redacted. */
  it('finish(FAILED) redacts a canary in the error before the write', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaTurnRepository(client, testRedactor);
    const turn = await repo.create({ chatId, model: 'gpt-5.6-sol' });
    await repo.finish(
      turn.id,
      'FAILED',
      { inputTokens: 0, outputTokens: 0, stepCount: 1 },
      `leaked ${GITHUB_CANARY}`,
    );
    const rows = await rawSelect<{ error: string }>(
      client,
      sqlTemplate('SELECT error FROM "Turn" WHERE id = '),
      turn.id,
    );
    expect(rows[0]?.error).toContain('[REDACTED]');
    expect(rows[0]?.error).not.toContain(GITHUB_CANARY);
  });

  /** listByChat() orders by queuedAt asc. */
  it('listByChat() orders by queuedAt asc', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaTurnRepository(client, testRedactor);
    const first = await repo.create({ chatId, model: 'gpt-5.6-sol' });
    const second = await repo.create({ chatId, model: 'gpt-5.6-sol' });
    const turns = await repo.listByChat(chatId);
    expect(turns.map((t) => t.id)).toEqual([first.id, second.id]);
  });

  /** get() on an unknown id returns null; setStatus() throws NotFoundError. */
  it('get() returns null and setStatus() throws NotFoundError for an unknown id', async () => {
    const repo = new PrismaTurnRepository(client, testRedactor);
    expect(await repo.get('missing')).toBeNull();
    await expect(repo.setStatus('missing', 'RUNNING')).rejects.toBeInstanceOf(NotFoundError);
  });
});
