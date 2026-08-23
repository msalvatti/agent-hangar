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
 * writes exactly the columns `setStatus` writes, answers `null` when no row matched, translates a
 * live-workspace conflict the same way, and refuses a move the lifecycle forbids before it reaches
 * the database at all.
 * Mocks: a Prisma client double exposing only `workspace.*` — no database.
 */
import { describe, expect, it, vi } from 'vitest';

import { IllegalTransitionError } from '../../errors.ts';
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

  /** Only READY stamps readyAt and only DESTROYED stamps destroyedAt; BUSY writes neither. */
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

  /** A claim refused with the row already gone falls back to the workspace id, like setStatus. */
  it('claimStatus() falls back to the workspace id when the row has no chat to read', async () => {
    const { client, workspace } = fakePrisma({
      updateManyAndReturn: vi.fn(() => Promise.reject(p2002LiveWorkspace())),
    });
    workspace.findUnique = vi.fn(() => Promise.resolve(null));
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);
    let caught: unknown;
    try {
      await repo.claimStatus('ws-1', 'CREATING', 'READY');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LiveWorkspaceExistsError);
    expect((caught as LiveWorkspaceExistsError).chatId).toBe('ws-1');
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

describe('what the workspace repository asks the database for', () => {
  /**
   * The entity name travels into every `NotFoundError` this repository raises, and it is what a
   * caller reads to say which row is missing. Emptied, a chat that has lost its workspace and a
   * turn that has lost its own row report the same thing.
   */
  it.each([
    ['markActive', async (repo: PrismaWorkspaceRepository) => repo.markActive('ws-1')],
    ['setStatus', async (repo: PrismaWorkspaceRepository) => repo.setStatus('ws-1', 'READY')],
    [
      'claimStatus',
      async (repo: PrismaWorkspaceRepository) => repo.claimStatus('ws-1', 'CREATING', 'READY'),
    ],
  ])('names the entity of a row %s could not find', async (_case, call) => {
    const failing = vi.fn(() => Promise.reject(p2025()));
    const repo = new PrismaWorkspaceRepository(
      fakePrisma({ update: failing, updateManyAndReturn: failing }).client,
      fakeRedactor,
    );

    const failure = await call(repo).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotFoundError);
    expect((failure as NotFoundError).entity).toBe('Workspace');
  });

  /**
   * The chat a failing workspace belongs to is read back on the error path, and it is read by id
   * and for that column alone. Asked without a `where` the answer is whatever row the database
   * returns first, and asked without a `select` the whole row travels — including the columns this
   * repository redacts on the way in.
   */
  it('reads the owning chat by id, and only that column', async () => {
    const { client, workspace } = fakePrisma({ update: vi.fn(() => Promise.reject(p2025())) });
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);

    await repo.setStatus('ws-1', 'BUSY').catch(() => undefined);

    expect(workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      select: { chatId: true },
    });
  });

  /**
   * A workspace read by id is read by id: without the filter the query answers with whichever row
   * the database happens to return, so a caller asking about one workspace is told about another.
   */
  it('reads one workspace by its id', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);

    await repo.get('ws-1');

    expect(workspace.findUnique).toHaveBeenCalledWith({ where: { id: 'ws-1' } });
  });

  /**
   * A create that collides reports the chat it collided on, and a job workspace has no chat — the
   * fallback says so rather than leaving the field absent, which reads as "unknown" further up.
   */
  it('names the chat a colliding create belongs to, or says there is none', async () => {
    const repo = new PrismaWorkspaceRepository(
      fakePrisma({ create: vi.fn(() => Promise.reject(p2002LiveWorkspace())) }).client,
      fakeRedactor,
    );

    const failure = await repo
      .create({
        kind: 'JOB',
        runnerKind: 'docker',
        image: 'img',
        repoUrl: 'https://github.com/acme/widgets',
        branch: 'main',
      })
      .catch((error: unknown) => error);

    expect((failure as LiveWorkspaceExistsError).chatId).toBe('none');
  });
});

describe('what the workspace repository writes and refuses', () => {
  /**
   * A status write carries exactly the columns it was given. An update that also names the columns
   * it was not given hands Prisma `undefined` for them, which the client treats as "leave alone"
   * today and which nothing here would notice changing.
   */
  it('writes only the columns the caller supplied', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);

    await repo.setStatus('ws-1', 'BUSY');

    // Read off the call rather than through the matcher, which treats a property that is present
    // and undefined as one that is absent — and present-and-undefined is exactly what a write that
    // names every column produces for the ones it was not given.
    expect(workspace.update.mock.calls).toStrictEqual([
      [{ where: { id: 'ws-1' }, data: { status: 'BUSY' } }],
    ]);
  });

  /**
   * The first-time stamp belongs to the move into READY. Written on every move, a workspace that
   * went READY, BUSY and READY again would have its readiness re-dated on a transition that is not
   * one — and the guarded write is what makes it first-time-only in the first place.
   */
  it('stamps readiness only on the move into READY', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);

    await repo.claimStatus('ws-1', 'READY', 'BUSY');

    expect(workspace.updateMany).not.toHaveBeenCalled();
  });

  /**
   * The lifecycle is checked before the database is touched at all. Without that check a move the
   * state machine forbids becomes a write that happens to match no row, which reads as "somebody
   * else got there first" rather than as the caller's own mistake.
   */
  it('refuses a forbidden move before writing anything', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);

    await expect(repo.claimStatus('ws-1', 'DESTROYED', 'READY')).rejects.toThrow(
      IllegalTransitionError,
    );
    expect(workspace.updateManyAndReturn).not.toHaveBeenCalled();
  });

  /**
   * A live-workspace collision raised by a status write reports the chat that already owns one,
   * read back on the error path — and when there is no such chat, or the row has gone, it falls
   * back to the workspace id rather than reporting a chat that does not exist.
   */
  it.each([
    ['the row names a chat', 'chat-1', 'chat-1'],
    ['the row has no chat', null, 'ws-1'],
  ])('reports the owner of a collision when %s', async (_case, chatId, expected) => {
    const { client, workspace } = fakePrisma({
      update: vi.fn(() => Promise.reject(p2002LiveWorkspace())),
    });
    workspace.findUnique.mockResolvedValue(chatId === null ? null : { ...workspaceRow, chatId });
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);

    const failure = await repo.setStatus('ws-1', 'READY').catch((error: unknown) => error);

    expect((failure as LiveWorkspaceExistsError).chatId).toBe(expected);
  });

  /**
   * The same on the claimed path, which is the one the worker takes: a claim that collides with a
   * live workspace has to say which chat already owns one, or the operator is sent to the
   * workspace that failed rather than to the chat holding the one in its way.
   */
  it('reports the owner of a collision raised by a claim', async () => {
    const { client, workspace } = fakePrisma({
      updateManyAndReturn: vi.fn(() => Promise.reject(p2002LiveWorkspace())),
    });
    workspace.findUnique.mockResolvedValue({ ...workspaceRow, chatId: 'chat-7' });
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);

    const failure = await repo
      .claimStatus('ws-1', 'CREATING', 'READY')
      .catch((error: unknown) => error);

    expect((failure as LiveWorkspaceExistsError).chatId).toBe('chat-7');
  });

  /**
   * The owner lookup runs on a path that is already failing, so it must not fail again: a database
   * that refuses the read leaves the original failure to be reported against the workspace id.
   */
  it('falls back to the workspace id when the owner lookup itself fails', async () => {
    const { client, workspace } = fakePrisma({
      update: vi.fn(() => Promise.reject(p2002LiveWorkspace())),
    });
    workspace.findUnique.mockRejectedValue(new Error('connection lost'));
    const repo = new PrismaWorkspaceRepository(client, fakeRedactor);

    const failure = await repo.setStatus('ws-1', 'READY').catch((error: unknown) => error);

    expect((failure as LiveWorkspaceExistsError).chatId).toBe('ws-1');
  });

  /** A create that finds no row to attach to reports which entity was missing. */
  it('names the entity of a create that could not find its row', async () => {
    const repo = new PrismaWorkspaceRepository(
      fakePrisma({ create: vi.fn(() => Promise.reject(p2025())) }).client,
      fakeRedactor,
    );

    const failure = await repo
      .create({
        kind: 'CHAT',
        chatId: 'chat-1',
        runnerKind: 'docker',
        image: 'img',
        repoUrl: 'https://github.com/acme/widgets',
        branch: 'main',
      })
      .catch((error: unknown) => error);

    expect((failure as NotFoundError).entity).toBe('Workspace');
  });
});
