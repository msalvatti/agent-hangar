/**
 * `@db` integration suite for `PrismaWorkspaceRepository`, against a real Postgres.
 *
 * Layer: integration.
 * Goal: pins the exact shape Postgres/Prisma report for the hand-written partial unique index
 * (`Workspace_one_live_per_chat`) so `prisma-errors.ts` can be trusted against it; a second live
 * workspace for one chat is refused, a workspace that has moved on (DESTROYED) frees the slot for
 * a new one, and two `JOB` workspaces with no chat coexist; `listIdle`/`listLive` build the right
 * result sets; a canary in `failureReason` is redacted before the write; a `setStatus` refused by
 * the partial index names the owning chat and rolls its `readyAt` stamp back.
 * Mocks: none — a real compose Postgres.
 */
import { beforeEach, expect, it } from 'vitest';

import type { Redactor } from '../../secrets/types.js';
import { OPENAI_CANARY } from '../../testing/canaries.js';
import type { PrismaClient } from '../generated/client.js';
import {
  connectTestDb,
  describeDb,
  rawSelect,
  seedChat,
  sqlTemplate,
  truncateAll,
} from '../testing/db.js';

import { LiveWorkspaceExistsError, NotFoundError } from './errors.js';
import { PrismaWorkspaceRepository } from './workspace.repository.js';

const testRedactor: Redactor = {
  register: () => undefined,
  redact: (input: string) => input.replaceAll(OPENAI_CANARY, '[REDACTED]'),
  redactJson: (input: unknown) => input,
};

const baseInput = {
  kind: 'CHAT' as const,
  runnerKind: 'docker',
  image: 'agent-hangar/workspace:dev',
  repoUrl: 'https://github.com/acme/repo',
  branch: 'main',
};

let client: PrismaClient;

describeDb('PrismaWorkspaceRepository', () => {
  beforeEach(async () => {
    client = connectTestDb();
    await truncateAll(client);
  });

  /** create() starts CREATING with lastActiveAt set and readyAt still null. */
  it('create() starts CREATING with lastActiveAt set and readyAt null', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaWorkspaceRepository(client, testRedactor);
    const workspace = await repo.create({ ...baseInput, chatId });
    expect(workspace.status).toBe('CREATING');
    expect(workspace.readyAt).toBeNull();
    expect(workspace.lastActiveAt).not.toBeNull();
  });

  /**
   * Pins the exact Prisma error shape for the hand-written partial index: this is the fixture
   * `prisma-errors.test.ts` is built to match.
   */
  it('a second live workspace for one chat is refused (pins the P2002 shape)', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaWorkspaceRepository(client, testRedactor);
    await repo.create({ ...baseInput, chatId });
    let caught: unknown;
    try {
      await repo.create({ ...baseInput, chatId });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LiveWorkspaceExistsError);
    expect((caught as LiveWorkspaceExistsError).chatId).toBe(chatId);
  });

  /** Once the first workspace is DESTROYED, a new live one for the same chat is accepted. */
  it('accepts a new live workspace once the previous one is DESTROYED', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaWorkspaceRepository(client, testRedactor);
    const first = await repo.create({ ...baseInput, chatId });
    await repo.setStatus(first.id, 'DESTROYED');
    const second = await repo.create({ ...baseInput, chatId });
    expect(second.id).not.toBe(first.id);
  });

  /**
   * Reviving a DESTROYED workspace while a sibling is live is refused by the partial index. The
   * error must name the chat (`setStatus` only knows the workspace id), and the guarded `readyAt`
   * stamp must roll back with the rejected status update rather than stay committed.
   */
  it('setStatus(READY) refused by the live index names the chat and leaves readyAt null', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaWorkspaceRepository(client, testRedactor);
    const first = await repo.create({ ...baseInput, chatId });
    await repo.setStatus(first.id, 'DESTROYED');
    await repo.create({ ...baseInput, chatId });

    let caught: unknown;
    try {
      await repo.setStatus(first.id, 'READY');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LiveWorkspaceExistsError);
    expect((caught as LiveWorkspaceExistsError).chatId).toBe(chatId);

    const rows = await rawSelect<{ readyAt: Date | null; status: string }>(
      client,
      sqlTemplate('SELECT "readyAt", status FROM "Workspace" WHERE id = '),
      first.id,
    );
    expect(rows[0]?.readyAt).toBeNull();
    expect(rows[0]?.status).toBe('DESTROYED');
  });

  /** Two JOB workspaces with no chat coexist: the partial index only constrains a non-null chatId. */
  it('two JOB workspaces with no chat coexist', async () => {
    const repo = new PrismaWorkspaceRepository(client, testRedactor);
    const a = await repo.create({ ...baseInput, kind: 'JOB' });
    const b = await repo.create({ ...baseInput, kind: 'JOB' });
    expect(a.id).not.toBe(b.id);
  });

  /** setStatus(READY) stamps readyAt once and sets runnerRef. */
  it('setStatus(READY, { runnerRef }) stamps readyAt and sets runnerRef', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaWorkspaceRepository(client, testRedactor);
    const workspace = await repo.create({ ...baseInput, chatId });
    const ready = await repo.setStatus(workspace.id, 'READY', { runnerRef: 'container-1' });
    expect(ready.readyAt).not.toBeNull();
    expect(ready.runnerRef).toBe('container-1');
  });

  /** A canary in failureReason is redacted before the write. */
  it('setStatus(FAILED, { failureReason }) redacts a canary before the write', async () => {
    const chatId = await seedChat(client);
    const repo = new PrismaWorkspaceRepository(client, testRedactor);
    const workspace = await repo.create({ ...baseInput, chatId });
    await repo.setStatus(workspace.id, 'FAILED', {
      failureReason: `image pull failed: ${OPENAI_CANARY}`,
    });
    const rows = await rawSelect<{ failureReason: string }>(
      client,
      sqlTemplate('SELECT "failureReason" FROM "Workspace" WHERE id = '),
      workspace.id,
    );
    expect(rows[0]?.failureReason).toContain('[REDACTED]');
    expect(rows[0]?.failureReason).not.toContain(OPENAI_CANARY);
  });

  /** listIdle() returns only READY rows older than the cutoff, ascending. */
  it('listIdle(cutoff) returns only READY rows older than the cutoff', async () => {
    const repo = new PrismaWorkspaceRepository(client, testRedactor);
    const old = await repo.create({ ...baseInput, kind: 'JOB' });
    await repo.setStatus(old.id, 'READY');
    await client.workspace.update({
      where: { id: old.id },
      data: { lastActiveAt: new Date('2020-01-01T00:00:00.000Z') },
    });
    const recent = await repo.create({ ...baseInput, kind: 'JOB' });
    await repo.setStatus(recent.id, 'READY');
    const idle = await repo.listIdle(new Date('2025-01-01T00:00:00.000Z'));
    expect(idle.map((w) => w.id)).toEqual([old.id]);
  });

  /** listLive() excludes DESTROYED workspaces. */
  it('listLive() excludes DESTROYED workspaces', async () => {
    const repo = new PrismaWorkspaceRepository(client, testRedactor);
    const live = await repo.create({ ...baseInput, kind: 'JOB' });
    const destroyed = await repo.create({ ...baseInput, kind: 'JOB' });
    await repo.setStatus(destroyed.id, 'DESTROYED');
    const listed = await repo.listLive();
    const ids = listed.map((w) => w.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(destroyed.id);
  });

  /** get() on an unknown id returns null; setStatus() throws NotFoundError. */
  it('get() returns null and setStatus() throws NotFoundError for an unknown id', async () => {
    const repo = new PrismaWorkspaceRepository(client, testRedactor);
    expect(await repo.get('missing')).toBeNull();
    await expect(repo.setStatus('missing', 'READY')).rejects.toBeInstanceOf(NotFoundError);
  });
});
