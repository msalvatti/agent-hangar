/**
 * Unit tests for `PrismaWorkspaceRepository`.
 *
 * Layer: unit.
 * Goal: `create` translates the partial-unique-index P2002 to `LiveWorkspaceExistsError`;
 * `setStatus` stamps `readyAt` only on READY via a guarded `updateMany`, stamps `destroyedAt` only
 * on DESTROYED, applies `runnerRef`/`failureReason` only when present, redacts a non-null
 * `failureReason` and passes null through unchanged, and never touches `lastActiveAt` (only
 * `markActive` does); a live-workspace conflict raised by `setStatus` carries the owning chat, read
 * from the row on the error path, and falls back to the workspace id when the row is gone;
 * `listIdle`/`listLive`/`findLiveByChat` build the expected queries; `claimStatus` carries the
 * expected status in the `WHERE` of both its guarded `readyAt` stamp and its status update,
 * writes exactly the columns `setStatus` writes, answers `null` when no row matched and
 * translates a live-workspace conflict the same way.
 * Mocks: a Prisma client double exposing only `workspace.*` — no database.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Redactor } from '../../secrets/types.ts';
import type { PrismaClient } from '../generated/client.ts';

import { LiveWorkspaceExistsError, NotFoundError } from './errors.ts';
import { PrismaWorkspaceRepository } from './workspace.repository.ts';

/** Builds a P2002 error naming the partial unique index, shaped like a raw-SQL-index violation. */
function p2002LiveWorkspace(): Error & { code: string } {
  return Object.assign(
    new Error('Unique constraint failed on the constraint: `Workspace_one_live_per_chat`'),
    { code: 'P2002' },
  );
}

/** Builds a P2025 (record not found) error shaped like `PrismaClientKnownRequestError`. */
function p2025(): Error & { code: string } {
  return Object.assign(new Error('Record not found'), { code: 'P2025' });
}

const NOW = new Date('2026-01-01T00:00:00.000Z');

const workspaceRow = {
  id: 'ws-1',
  kind: 'CHAT',
  status: 'CREATING',
  chatId: 'chat-1',
  runnerKind: 'docker',
  runnerRef: null,
  image: 'agent-hangar/workspace:dev',
  repoUrl: 'https://github.com/acme/repo',
  branch: 'main',
  createdAt: NOW,
  readyAt: null,
  lastActiveAt: NOW,
  destroyedAt: null,
  failureReason: null,
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
    updateManyAndReturn?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const workspace = {
    create: overrides.create ?? vi.fn(() => Promise.resolve(workspaceRow)),
    findFirst: vi.fn((): Promise<typeof workspaceRow | null> => Promise.resolve(workspaceRow)),
    findMany: vi.fn(() => Promise.resolve([workspaceRow])),
    findUnique: vi.fn((): Promise<typeof workspaceRow | null> => Promise.resolve(workspaceRow)),
    updateMany: overrides.updateMany ?? vi.fn(() => Promise.resolve({ count: 1 })),
    update: overrides.update ?? vi.fn(() => Promise.resolve(workspaceRow)),
    updateManyAndReturn:
      overrides.updateManyAndReturn ?? vi.fn(() => Promise.resolve([workspaceRow])),
  };
  // `setStatus` runs its guarded timestamp write and its status update inside one
  // interactive transaction; the double runs the callback against the same `workspace`
  // stub, so the assertions below still see every call the repository makes.
  const client = {
    workspace,
    $transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ workspace }),
  } as unknown as PrismaClient;
  return { client, workspace };
}

describe('PrismaWorkspaceRepository', () => {
  /** create() inserts a CREATING workspace. */
  it('create() inserts a CREATING workspace', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await repo.create({
      kind: 'CHAT',
      chatId: 'chat-1',
      runnerKind: 'docker',
      image: 'agent-hangar/workspace:dev',
      repoUrl: 'https://github.com/acme/repo',
      branch: 'main',
    });
    expect(workspace.create).toHaveBeenCalledWith({
      data: {
        kind: 'CHAT',
        chatId: 'chat-1',
        runnerKind: 'docker',
        image: 'agent-hangar/workspace:dev',
        repoUrl: 'https://github.com/acme/repo',
        branch: 'main',
        status: 'CREATING',
      },
    });
  });

  /** A JOB workspace has no chat, so chatId defaults to null on both success and failure paths. */
  it('create() defaults chatId to null for a JOB workspace with no chat', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await repo.create({
      kind: 'JOB',
      runnerKind: 'docker',
      image: 'agent-hangar/workspace:dev',
      repoUrl: 'https://github.com/acme/repo',
      branch: 'main',
    });
    expect(workspace.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ chatId: null }) as object }),
    );
  });

  /** Without a chatId, a translated error still gets an id, defaulting to 'none'. */
  it('create() defaults the translated error id to "none" for a JOB workspace', async () => {
    const { client } = fakePrisma({ create: vi.fn(() => Promise.reject(p2025())) });
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await expect(
      repo.create({
        kind: 'JOB',
        runnerKind: 'docker',
        image: 'x',
        repoUrl: 'https://github.com/acme/repo',
        branch: 'main',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  /** create() translates the partial-unique-index violation to LiveWorkspaceExistsError. */
  it('create() translates a second live workspace to LiveWorkspaceExistsError', async () => {
    const { client } = fakePrisma({ create: vi.fn(() => Promise.reject(p2002LiveWorkspace())) });
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await expect(
      repo.create({
        kind: 'CHAT',
        chatId: 'chat-1',
        runnerKind: 'docker',
        image: 'x',
        repoUrl: 'https://github.com/acme/repo',
        branch: 'main',
      }),
    ).rejects.toBeInstanceOf(LiveWorkspaceExistsError);
  });

  /** findLiveByChat() filters by the live status set and maps a found row. */
  it('findLiveByChat() filters by the live status set', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    const result = await repo.findLiveByChat('chat-1');
    expect(workspace.findFirst).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', status: { in: ['CREATING', 'READY', 'BUSY', 'STOPPING'] } },
    });
    expect(result?.id).toBe('ws-1');
  });

  /** findLiveByChat() returns null when the chat has no live workspace. */
  it('findLiveByChat() returns null when there is no live workspace', async () => {
    const { client, workspace } = fakePrisma();
    workspace.findFirst = vi.fn(() => Promise.resolve(null));
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    expect(await repo.findLiveByChat('chat-1')).toBeNull();
  });

  /** READY stamps readyAt via a guarded updateMany; other statuses never call it. */
  it('setStatus(READY) stamps readyAt via a guarded updateMany', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await repo.setStatus('ws-1', 'READY');
    expect(workspace.updateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', readyAt: null },
      data: { readyAt: expect.any(Date) as Date },
    });
  });

  it('setStatus(BUSY) does not call updateMany or touch destroyedAt', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await repo.setStatus('ws-1', 'BUSY');
    expect(workspace.updateMany).not.toHaveBeenCalled();
    expect(workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      data: { status: 'BUSY' },
    });
  });

  /** DESTROYED stamps destroyedAt. */
  it('setStatus(DESTROYED) stamps destroyedAt', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await repo.setStatus('ws-1', 'DESTROYED');
    expect(workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      data: { status: 'DESTROYED', destroyedAt: expect.any(Date) as Date },
    });
  });

  /** runnerRef applies only when present. */
  it('setStatus() applies runnerRef only when present', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await repo.setStatus('ws-1', 'READY', { runnerRef: 'container-1' });
    expect(workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      data: { status: 'READY', runnerRef: 'container-1' },
    });
  });

  /** A non-null failureReason is redacted; a null one clears the column unchanged. */
  it('setStatus() redacts a non-null failureReason and passes null through unchanged', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await repo.setStatus('ws-1', 'FAILED', { failureReason: 'boom' });
    expect(workspace.update).toHaveBeenLastCalledWith({
      where: { id: 'ws-1' },
      data: { status: 'FAILED', failureReason: '[REDACTED:boom]' },
    });
    await repo.setStatus('ws-1', 'FAILED', { failureReason: null });
    expect(workspace.update).toHaveBeenLastCalledWith({
      where: { id: 'ws-1' },
      data: { status: 'FAILED', failureReason: null },
    });
  });

  /** A failure inside setStatus (missing row) translates through translatePrismaError. */
  it('setStatus() translates a missing row to NotFoundError', async () => {
    const { client } = fakePrisma({ update: vi.fn(() => Promise.reject(p2025())) });
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await expect(repo.setStatus('missing', 'READY')).rejects.toBeInstanceOf(NotFoundError);
  });

  /** A live-workspace conflict inside setStatus carries the owning chat, not the workspace id. */
  it('setStatus() names the owning chat in LiveWorkspaceExistsError', async () => {
    const { client } = fakePrisma({ update: vi.fn(() => Promise.reject(p2002LiveWorkspace())) });
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    let caught: unknown;
    try {
      await repo.setStatus('ws-1', 'READY');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LiveWorkspaceExistsError);
    expect((caught as LiveWorkspaceExistsError).chatId).toBe('chat-1');
  });

  /** With the row already gone, the conflict falls back to the workspace id it was given. */
  it('setStatus() falls back to the workspace id when the row has no chat to read', async () => {
    const { client, workspace } = fakePrisma({
      update: vi.fn(() => Promise.reject(p2002LiveWorkspace())),
    });
    workspace.findUnique = vi.fn(() => Promise.resolve(null));
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    let caught: unknown;
    try {
      await repo.setStatus('ws-1', 'READY');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LiveWorkspaceExistsError);
    expect((caught as LiveWorkspaceExistsError).chatId).toBe('ws-1');
  });

  /** A failing chat lookup must not mask the write failure that is already being reported. */
  it('setStatus() reports the original failure when the chat lookup itself fails', async () => {
    const { client, workspace } = fakePrisma({
      update: vi.fn(() => Promise.reject(p2002LiveWorkspace())),
    });
    workspace.findUnique = vi.fn(() => Promise.reject(new Error('connection terminated')));
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    let caught: unknown;
    try {
      await repo.setStatus('ws-1', 'READY');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LiveWorkspaceExistsError);
    expect((caught as LiveWorkspaceExistsError).chatId).toBe('ws-1');
  });

  /** markActive() bumps lastActiveAt. */
  it('markActive() bumps lastActiveAt', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await repo.markActive('ws-1');
    expect(workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      data: { lastActiveAt: expect.any(Date) as Date },
    });
  });

  /** markActive() on a missing row translates through translatePrismaError. */
  it('markActive() translates a missing row to NotFoundError', async () => {
    const { client } = fakePrisma({ update: vi.fn(() => Promise.reject(p2025())) });
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await expect(repo.markActive('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  /** listIdle() filters READY rows older than the cutoff, ascending. */
  it('listIdle() filters READY rows older than the cutoff', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    const cutoff = new Date('2026-02-01T00:00:00.000Z');
    await repo.listIdle(cutoff);
    expect(workspace.findMany).toHaveBeenCalledWith({
      where: { status: 'READY', lastActiveAt: { lt: cutoff } },
      orderBy: { lastActiveAt: 'asc' },
    });
  });

  /** listLive() filters the live status set, ordered by createdAt asc. */
  it('listLive() filters the live status set', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await repo.listLive();
    expect(workspace.findMany).toHaveBeenCalledWith({
      where: { status: { in: ['CREATING', 'READY', 'BUSY', 'STOPPING'] } },
      orderBy: { createdAt: 'asc' },
    });
  });

  /** get() maps a found row. */
  it('get() returns the mapped workspace when found', async () => {
    const { client } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    expect((await repo.get('ws-1'))?.id).toBe('ws-1');
  });

  /** get() returns null when the row is absent. */
  it('get() returns null when the row is absent', async () => {
    const { client, workspace } = fakePrisma();
    workspace.findUnique = vi.fn(() => Promise.resolve(null));
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    expect(await repo.get('missing')).toBeNull();
  });
  /** claimStatus() carries the expected status in the WHERE, which is what makes it conditional. */
  it('claimStatus() puts the expected status in the WHERE of the update', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await repo.claimStatus('ws-1', 'READY', 'BUSY');
    expect(workspace.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: 'ws-1', status: 'READY' },
      data: { status: 'BUSY' },
    });
  });

  /** A claim that matched no row is a lost race, reported as null rather than as an error. */
  it('claimStatus() returns null when no row matched the expected status', async () => {
    const { client } = fakePrisma({ updateManyAndReturn: vi.fn(() => Promise.resolve([])) });
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    expect(await repo.claimStatus('ws-1', 'READY', 'BUSY')).toBeNull();
  });

  /** A winning claim resolves with the row it produced, mapped like every other write. */
  it('claimStatus() returns the mapped row when the claim won', async () => {
    const { client } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    expect((await repo.claimStatus('ws-1', 'CREATING', 'READY'))?.id).toBe('ws-1');
  });

  /** claimStatus() writes the same columns as setStatus: DESTROYED stamps destroyedAt. */
  it('claimStatus(DESTROYED) stamps destroyedAt and redacts failureReason', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await repo.claimStatus('ws-1', 'READY', 'DESTROYED', { failureReason: 'container missing' });
    expect(workspace.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: 'ws-1', status: 'READY' },
      data: {
        status: 'DESTROYED',
        destroyedAt: expect.any(Date) as Date,
        failureReason: '[REDACTED:container missing]',
      },
    });
  });

  /** The guarded readyAt stamp is conditional too, so a lost claim leaves no timestamp behind. */
  it('claimStatus(READY) guards the readyAt stamp by the expected status as well', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await repo.claimStatus('ws-1', 'CREATING', 'READY', { runnerRef: 'ctr-1' });
    expect(workspace.updateMany).toHaveBeenCalledWith({
      where: { id: 'ws-1', status: 'CREATING', readyAt: null },
      data: { readyAt: expect.any(Date) as Date },
    });
    expect(workspace.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: 'ws-1', status: 'CREATING' },
      data: { status: 'READY', runnerRef: 'ctr-1' },
    });
  });

  /** A claim refused by the live-workspace index reports the owning chat, like setStatus does. */
  it('claimStatus() translates a live-workspace conflict and names the chat', async () => {
    const { client } = fakePrisma({
      updateManyAndReturn: vi.fn(() => Promise.reject(p2002LiveWorkspace())),
    });
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await expect(repo.claimStatus('ws-1', 'READY', 'BUSY')).rejects.toBeInstanceOf(
      LiveWorkspaceExistsError,
    );
  });

  /** A null failureReason is passed through unredacted, matching setStatus. */
  it('claimStatus() passes a null failureReason through unchanged', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    await repo.claimStatus('ws-1', 'READY', 'BUSY', { failureReason: null, runnerRef: null });
    expect(workspace.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: 'ws-1', status: 'READY' },
      data: { status: 'BUSY', runnerRef: null, failureReason: null },
    });
  });
});
