/**
 * `@db` integration suite for `PrismaChatRepository`, against a real Postgres.
 *
 * Layer: integration.
 * Goal: create/getById round-trips every field; `list` orders by `updatedAt` desc and filters by
 * status; `setStatus` stamps/clears `archivedAt`; `updateRestoreHints` changes only the field
 * present; `delete` cascades messages/turns and nulls a workspace's `chatId`; unknown ids throw
 * `NotFoundError`; a canary in the title never reaches the stored row, on create or on rename.
 * Mocks: none — a real compose Postgres (`AH_ALLOW_DESTRUCTIVE_TESTS=1`, a test-named database).
 */
import { beforeEach, expect, it } from 'vitest';

import type { Redactor } from '../../secrets/types.ts';
import { assertNoCanary, GITHUB_CANARY } from '../../testing/canaries.ts';
import type { PrismaClient } from '../generated/client.ts';
import {
  connectTestDb,
  countRows,
  describeDb,
  rawSelect,
  sqlTemplate,
  truncateAll,
} from '../testing/db.ts';

import { PrismaChatRepository } from './chat.repository.ts';
import { NotFoundError } from './errors.ts';

const testRedactor: Redactor = {
  register: () => undefined,
  redact: (input: string) => input.replaceAll(GITHUB_CANARY, '[REDACTED]'),
  redactJson: (input: unknown) => input,
};

let client: PrismaClient;

describeDb('PrismaChatRepository', () => {
  beforeEach(async () => {
    client = connectTestDb();
    await truncateAll(client);
  });

  /** A canary in the title never reaches the stored row, on create or on rename. */
  it('never stores a canary in title', async () => {
    const repo = new PrismaChatRepository(client, testRedactor);
    const chat = await repo.create({
      title: `fix auth with ${GITHUB_CANARY}`,
      repoUrl: 'https://github.com/acme/repo',
      baseBranch: 'main',
    });
    const created = await rawSelect<{ title: string }>(
      client,
      sqlTemplate('SELECT title FROM "Chat" WHERE id = '),
      chat.id,
    );
    const createdTitle = created[0]?.title ?? '';
    expect(createdTitle).toContain('[REDACTED]');
    assertNoCanary(createdTitle);

    await repo.rename(chat.id, `renamed with ${GITHUB_CANARY}`);
    const renamed = await rawSelect<{ title: string }>(
      client,
      sqlTemplate('SELECT title FROM "Chat" WHERE id = '),
      chat.id,
    );
    const renamedTitle = renamed[0]?.title ?? '';
    expect(renamedTitle).toContain('[REDACTED]');
    assertNoCanary(renamedTitle);
  });

  /** create() round-trips every field; getById() returns the same row. */
  it('create() then getById() round-trip every field', async () => {
    const repo = new PrismaChatRepository(client, testRedactor);
    const chat = await repo.create({
      title: 'Fix the bug',
      repoUrl: 'https://github.com/acme/repo',
      baseBranch: 'main',
    });
    expect(chat.status).toBe('ACTIVE');
    expect(chat.archivedAt).toBeNull();
    const fetched = await repo.getById(chat.id);
    expect(fetched).toEqual(chat);
  });

  /** list() orders by updatedAt desc: touching the older chat moves it first. */
  it('list() orders by updatedAt desc', async () => {
    const repo = new PrismaChatRepository(client, testRedactor);
    const first = await repo.create({
      title: 'First',
      repoUrl: 'https://github.com/a/a',
      baseBranch: 'main',
    });
    await repo.create({ title: 'Second', repoUrl: 'https://github.com/b/b', baseBranch: 'main' });
    // `updatedAt` has millisecond precision; a small delay guarantees the touch below is strictly
    // later than "Second"'s creation instead of racing it within the same millisecond.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await repo.touch(first.id);
    const ordered = await repo.list();
    expect(ordered[0]?.id).toBe(first.id);
  });

  /** list(status) filters, and setStatus/ACTIVE round-trip archivedAt. */
  it('setStatus(ARCHIVED) stamps archivedAt and list("ARCHIVED") finds it; ACTIVE clears it', async () => {
    const repo = new PrismaChatRepository(client, testRedactor);
    const chat = await repo.create({
      title: 'X',
      repoUrl: 'https://github.com/a/a',
      baseBranch: 'main',
    });
    const archived = await repo.setStatus(chat.id, 'ARCHIVED');
    expect(archived.archivedAt).not.toBeNull();
    const archivedList = await repo.list('ARCHIVED');
    expect(archivedList.map((c) => c.id)).toContain(chat.id);
    const reactivated = await repo.setStatus(chat.id, 'ACTIVE');
    expect(reactivated.archivedAt).toBeNull();
  });

  /** updateRestoreHints() with only one field present leaves the other untouched. */
  it('updateRestoreHints() with only lastPushedSha leaves workBranch untouched', async () => {
    const repo = new PrismaChatRepository(client, testRedactor);
    const chat = await repo.create({
      title: 'X',
      repoUrl: 'https://github.com/a/a',
      baseBranch: 'main',
    });
    await repo.updateRestoreHints(chat.id, { workBranch: 'agent/1' });
    const updated = await repo.updateRestoreHints(chat.id, { lastPushedSha: 'sha1' });
    expect(updated.workBranch).toBe('agent/1');
    expect(updated.lastPushedSha).toBe('sha1');
  });

  /** delete() cascades messages/turns and nulls the chatId of a workspace it owned. */
  it('delete() cascades messages and turns, and nulls a workspace chatId', async () => {
    const repo = new PrismaChatRepository(client, testRedactor);
    const chat = await repo.create({
      title: 'X',
      repoUrl: 'https://github.com/a/a',
      baseBranch: 'main',
    });
    await client.message.create({
      data: { chatId: chat.id, seq: 1, role: 'USER', content: 'hi' },
    });
    const turn = await client.turn.create({ data: { chatId: chat.id, model: 'gpt-5.6-sol' } });
    const workspace = await client.workspace.create({
      data: {
        kind: 'CHAT',
        chatId: chat.id,
        runnerKind: 'docker',
        image: 'agent-hangar/workspace:dev',
        repoUrl: 'https://github.com/a/a',
        branch: 'main',
      },
    });
    await repo.delete(chat.id);
    expect(await countRows(client, 'Message')).toBe(0);
    expect(await countRows(client, 'Turn')).toBe(0);
    void turn;
    const remainingWorkspace = await client.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
    });
    expect(remainingWorkspace.chatId).toBeNull();
  });

  /** setStatus/delete on an unknown id throw NotFoundError. */
  it('setStatus() and delete() on an unknown id throw NotFoundError', async () => {
    const repo = new PrismaChatRepository(client, testRedactor);
    await expect(repo.setStatus('missing', 'ARCHIVED')).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.delete('missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});
