/**
 * Unit tests for `PrismaJobRunRepository`.
 *
 * Layer: unit.
 * Goal: `create` starts a run QUEUED and translates a missing scheduled-job parent (P2003) to
 * `NotFoundError('ScheduledJob', jobId)`; `recordPush` writes both push columns and names the run
 * when there is no such row; `setStatus` stamps
 * `startedAt` only on PREPARING via a guarded `updateMany`, applies `workspaceId`/`error` only
 * when present, redacts a non-null `error`; `finish` redacts `output`/`error` only when provided,
 * leaves them untouched when omitted, and names the live statuses in its own `where` so a run that
 * already carries an outcome is not overwritten; `listByJob`/`findRunningByJob` build the expected
 * queries; a workspace reference is checked for kind inside the same transaction and refused when
 * the row is missing or is a chat's; failures translate through `translatePrismaError`. What that
 * condition produces against a real database is pinned by the shared contract, which no client
 * double can settle.
 * Mocks: a Prisma client double exposing only `jobRun.*` — no database.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Redactor } from '../../secrets/types.ts';
import { LIVE_RUN_STATUSES } from '../../workspace/lifecycle.ts';
import type { PrismaClient } from '../generated/client.ts';

import { NotFoundError, UniqueViolationError, WorkspaceKindMismatchError } from './errors.ts';
import { PrismaJobRunRepository } from './job-run.repository.ts';

/** Builds a P2002 error naming the `workspaceId` unique constraint. */
function p2002Workspace(): Error & { code: string; meta: { target: string[] } } {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target: ['workspaceId'] },
  });
}

const NOW = new Date('2026-01-01T00:00:00.000Z');

const runRow = {
  id: 'run-1',
  jobId: 'job-1',
  workspaceId: null,
  status: 'QUEUED',
  trigger: 'MANUAL',
  model: 'gpt-5.6-sol',
  output: null,
  error: null,
  inputTokens: null,
  outputTokens: null,
  stepCount: 0,
  scheduledFor: NOW,
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
    workspaceKind?: 'CHAT' | 'JOB' | null;
  } = {},
) {
  const workspaceRow =
    overrides.workspaceKind === null ? null : { kind: overrides.workspaceKind ?? 'JOB' };
  const workspace = {
    findUnique: vi.fn((): Promise<{ kind: string } | null> => Promise.resolve(workspaceRow)),
  };
  const jobRun = {
    create: overrides.create ?? vi.fn(() => Promise.resolve(runRow)),
    findFirst: vi.fn((): Promise<typeof runRow | null> => Promise.resolve(runRow)),
    findMany: vi.fn(() => Promise.resolve([runRow])),
    findUnique: vi.fn((): Promise<typeof runRow | null> => Promise.resolve(runRow)),
    updateMany: overrides.updateMany ?? vi.fn(() => Promise.resolve({ count: 1 })),
    updateManyAndReturn: overrides.updateManyAndReturn ?? vi.fn(() => Promise.resolve([runRow])),
    update: overrides.update ?? vi.fn(() => Promise.resolve(runRow)),
  };
  // `setStatus` runs its guarded timestamp write and its status update inside one
  // interactive transaction; the double runs the callback against the same `jobRun`
  // stub, so the assertions below still see every call the repository makes.
  const client = {
    jobRun,
    workspace,
    $transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ jobRun, workspace }),
  } as unknown as PrismaClient;
  return { client, jobRun, workspace };
}

describe('PrismaJobRunRepository', () => {
  /** create() inserts a QUEUED run. */
  it('create() inserts a QUEUED run', async () => {
    const { client, jobRun } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    await repo.create({
      jobId: 'job-1',
      trigger: 'MANUAL',
      model: 'gpt-5.6-sol',
      scheduledFor: NOW,
    });
    expect(jobRun.create).toHaveBeenCalledWith({
      data: {
        jobId: 'job-1',
        trigger: 'MANUAL',
        model: 'gpt-5.6-sol',
        scheduledFor: NOW,
        status: 'QUEUED',
      },
    });
  });

  /**
   * The push is written to the two columns the reader maps, and the caller is handed the run as it
   * now stands rather than the row it passed in.
   */
  it('recordPush() writes both columns and returns the mapped run', async () => {
    const update = vi.fn(() =>
      Promise.resolve({
        ...runRow,
        workBranch: 'agent/job-2f7c11a0',
        lastPushedSha: 'c0ffee1234567890',
      }),
    );
    const { client } = fakePrisma({ update });
    const repo = new PrismaJobRunRepository(client, fakeRedactor);

    const run = await repo.recordPush('run-1', {
      workBranch: 'agent/job-2f7c11a0',
      lastPushedSha: 'c0ffee1234567890',
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { workBranch: 'agent/job-2f7c11a0', lastPushedSha: 'c0ffee1234567890' },
    });
    expect(run).toMatchObject({
      id: 'run-1',
      workBranch: 'agent/job-2f7c11a0',
      lastPushedSha: 'c0ffee1234567890',
    });
  });

  /**
   * A push for a run the database does not have names the run, not the scheduled job: the worker
   * reaches this with a run id it created itself, so the missing row is the thing the caller has
   * to be told about.
   */
  it('recordPush() translates a missing run to NotFoundError naming the run', async () => {
    const p2025 = Object.assign(new Error('Record to update not found'), { code: 'P2025' });
    const { client } = fakePrisma({ update: vi.fn(() => Promise.reject(p2025)) });
    const repo = new PrismaJobRunRepository(client, fakeRedactor);

    await expect(
      repo.recordPush('run-gone', { workBranch: 'agent/job-x', lastPushedSha: 'deadbeefdeadbeef' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  /** Postgres reports a missing parent as P2003, translated to NotFoundError('ScheduledJob', id). */
  it('create() translates a missing scheduled job to NotFoundError naming the job', async () => {
    const p2003 = Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' });
    const { client } = fakePrisma({ create: vi.fn(() => Promise.reject(p2003)) });
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    let caught: unknown;
    try {
      await repo.create({
        jobId: 'missing',
        trigger: 'MANUAL',
        model: 'gpt-5.6-sol',
        scheduledFor: NOW,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect((caught as NotFoundError).entity).toBe('ScheduledJob');
    expect((caught as NotFoundError).id).toBe('missing');
  });

  /** PREPARING guards startedAt with updateMany; other statuses never call it. */
  it('setStatus(PREPARING) stamps startedAt via a guarded updateMany', async () => {
    const { client, jobRun } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    await repo.setStatus('run-1', 'PREPARING');
    expect(jobRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', startedAt: null },
      data: { startedAt: expect.any(Date) as Date },
    });
  });

  /** Only PREPARING stamps `startedAt`, so no other status pays for the guarded write. */
  it('setStatus(RUNNING) does not call updateMany', async () => {
    const { client, jobRun } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    await repo.setStatus('run-1', 'RUNNING');
    expect(jobRun.updateMany).not.toHaveBeenCalled();
  });

  /** workspaceId applies only when present. */
  it('setStatus() applies workspaceId only when present', async () => {
    const { client, jobRun } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    await repo.setStatus('run-1', 'RUNNING', { workspaceId: 'ws-1' });
    expect(jobRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { status: 'RUNNING', workspaceId: 'ws-1' },
    });
  });

  /** A non-null error is redacted; a null error clears the column unchanged. */
  it('setStatus() redacts a non-null error and passes null through unchanged', async () => {
    const { client, jobRun } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    await repo.setStatus('run-1', 'FAILED', { error: 'boom' });
    expect(jobRun.update).toHaveBeenLastCalledWith({
      where: { id: 'run-1' },
      data: { status: 'FAILED', error: '[REDACTED:boom]' },
    });
    await repo.setStatus('run-1', 'FAILED', { error: null });
    expect(jobRun.update).toHaveBeenLastCalledWith({
      where: { id: 'run-1' },
      data: { status: 'FAILED', error: null },
    });
  });

  /** setStatus() translates the workspaceId unique violation. */
  it('setStatus() translates a duplicate workspaceId to UniqueViolationError', async () => {
    const { client } = fakePrisma({ update: vi.fn(() => Promise.reject(p2002Workspace())) });
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    await expect(
      repo.setStatus('run-1', 'RUNNING', { workspaceId: 'ws-taken' }),
    ).rejects.toBeInstanceOf(UniqueViolationError);
  });

  /**
   * finish() sets usage/finishedAt without output/error fields when both are omitted, and carries
   * the live statuses in its `where`: an `update` by id would satisfy every other assertion here
   * and still overwrite an outcome somebody else had already recorded.
   */
  it('finish() omits output/error entirely when not provided', async () => {
    const { client, jobRun } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    await repo.finish('run-1', {
      status: 'SUCCEEDED',
      usage: { inputTokens: 1, outputTokens: 2, stepCount: 1 },
    });
    expect(jobRun.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: 'run-1', status: { in: [...LIVE_RUN_STATUSES] } },
      data: {
        status: 'SUCCEEDED',
        inputTokens: 1,
        outputTokens: 2,
        stepCount: 1,
        finishedAt: expect.any(Date) as Date,
      },
    });
  });

  /** finish() redacts a non-null output/error and passes null through unchanged. */
  it('finish() redacts non-null output/error and passes null through unchanged', async () => {
    const { client, jobRun } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    await repo.finish('run-1', {
      status: 'FAILED',
      usage: { inputTokens: 0, outputTokens: 0, stepCount: 1 },
      output: 'done',
      error: 'boom',
    });
    expect(jobRun.updateManyAndReturn).toHaveBeenLastCalledWith({
      where: { id: 'run-1', status: { in: [...LIVE_RUN_STATUSES] } },
      data: {
        status: 'FAILED',
        inputTokens: 0,
        outputTokens: 0,
        stepCount: 1,
        finishedAt: expect.any(Date) as Date,
        output: '[REDACTED:done]',
        error: '[REDACTED:boom]',
      },
    });
    await repo.finish('run-1', {
      status: 'FAILED',
      usage: { inputTokens: 0, outputTokens: 0, stepCount: 1 },
      output: null,
      error: null,
    });
    expect(jobRun.updateManyAndReturn).toHaveBeenLastCalledWith({
      where: { id: 'run-1', status: { in: [...LIVE_RUN_STATUSES] } },
      data: {
        status: 'FAILED',
        inputTokens: 0,
        outputTokens: 0,
        stepCount: 1,
        finishedAt: expect.any(Date) as Date,
        output: null,
        error: null,
      },
    });
  });

  /**
   * Nothing matched, so nothing was recorded and the caller is told so rather than being handed an
   * exception: losing a race is an outcome a caller handles, not a fault.
   */
  it('finish() answers null when no live row matched', async () => {
    const { client } = fakePrisma({ updateManyAndReturn: vi.fn(() => Promise.resolve([])) });
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    expect(
      await repo.finish('missing', {
        status: 'SUCCEEDED',
        usage: { inputTokens: 0, outputTokens: 0, stepCount: 0 },
      }),
    ).toBeNull();
  });

  /** listByJob() orders newest first and applies limit only when present. */
  it('listByJob() orders queuedAt desc without a limit', async () => {
    const { client, jobRun } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    await repo.listByJob('job-1');
    expect(jobRun.findMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1' },
      orderBy: { queuedAt: 'desc' },
    });
  });

  /** A limit becomes a `take`, so the runs list is bounded by the query rather than in memory. */
  it('listByJob({ limit }) applies a take clause', async () => {
    const { client, jobRun } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    await repo.listByJob('job-1', { limit: 5 });
    expect(jobRun.findMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1' },
      orderBy: { queuedAt: 'desc' },
      take: 5,
    });
  });

  /** get() maps a found row and returns null when absent. */
  it('get() returns the mapped run or null', async () => {
    const { client, jobRun } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    expect((await repo.get('run-1'))?.id).toBe('run-1');
    jobRun.findUnique = vi.fn(() => Promise.resolve(null));
    expect(await repo.get('missing')).toBeNull();
  });

  /** findRunningByJob() filters PREPARING/RUNNING and maps null when absent. */
  it('findRunningByJob() filters PREPARING/RUNNING', async () => {
    const { client, jobRun } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    const result = await repo.findRunningByJob('job-1');
    expect(jobRun.findFirst).toHaveBeenCalledWith({
      where: { jobId: 'job-1', status: { in: ['PREPARING', 'RUNNING'] } },
    });
    expect(result?.id).toBe('run-1');
    jobRun.findFirst = vi.fn(() => Promise.resolve(null));
    expect(await repo.findRunningByJob('job-1')).toBeNull();
  });

  /** A run may only be pointed at a job workspace; a chat's is refused before the update runs. */
  it('setStatus() refuses a chat workspace and never writes the reference', async () => {
    const { client, jobRun } = fakePrisma({ workspaceKind: 'CHAT' });
    const repo = new PrismaJobRunRepository(client, fakeRedactor);

    await expect(
      repo.setStatus('run-1', 'PREPARING', { workspaceId: 'ws-chat' }),
    ).rejects.toBeInstanceOf(WorkspaceKindMismatchError);
    expect(jobRun.update).not.toHaveBeenCalled();
  });

  /** An id no workspace carries is told apart from a workspace of the wrong kind. */
  it('setStatus() refuses a workspace id no row carries', async () => {
    const { client, jobRun } = fakePrisma({ workspaceKind: null });
    const repo = new PrismaJobRunRepository(client, fakeRedactor);

    await expect(
      repo.setStatus('run-1', 'PREPARING', { workspaceId: 'ws-gone' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(jobRun.update).not.toHaveBeenCalled();
  });

  /** Clearing the reference names no workspace, so nothing is looked up. */
  it('setStatus() clearing the workspace looks no workspace up', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);

    await repo.setStatus('run-1', 'FAILED', { workspaceId: null });

    expect(workspace.findUnique).not.toHaveBeenCalled();
  });
});

describe('what the job-run repository asks the database for', () => {
  /**
   * The workspace a run is attached to is read by id and for its kind alone. Without the filter
   * the check passes on whatever row comes back first, and without the column list the whole row
   * travels for a question about one field.
   */
  it('checks the workspace kind by id, and only that column', async () => {
    const { client, workspace } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);

    await repo.setStatus('run-1', 'RUNNING', { workspaceId: 'ws-1' });

    expect(workspace.findUnique.mock.calls).toStrictEqual([
      [{ where: { id: 'ws-1' }, select: { kind: true } }],
    ]);
  });

  /** A run read by id is addressed by id, or a caller is shown another job's run. */
  it('reads one run by its id', async () => {
    const { client, jobRun } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);

    await repo.get('run-1');

    expect(jobRun.findUnique.mock.calls).toStrictEqual([[{ where: { id: 'run-1' } }]]);
  });

  /**
   * A listing with no limit asks for no limit; one with a limit asks for exactly it. Sent a page
   * size of nothing, the run history a person is shown is whatever the driver made of it.
   */
  it.each([
    ['no limit', {}, undefined],
    ['the limit it was given', { limit: 5 }, 5],
  ])('asks for %s', async (_case, options, take) => {
    const { client, jobRun } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);

    await repo.listByJob('job-1', options);

    expect((jobRun.findMany.mock.calls as unknown[][])[0]?.[0]).toStrictEqual({
      where: { jobId: 'job-1' },
      orderBy: { queuedAt: 'desc' },
      ...(take === undefined ? {} : { take }),
    });
  });

  /**
   * A status write carries exactly the fields it was given: a workspace the caller did not mention
   * must not appear in the write, and must not send the run through the workspace-kind check on
   * its way.
   */
  it('writes only the fields the caller supplied with a status', async () => {
    const { client, jobRun, workspace } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);

    await repo.setStatus('run-1', 'RUNNING');

    expect(jobRun.update.mock.calls).toStrictEqual([
      [{ where: { id: 'run-1' }, data: { status: 'RUNNING' } }],
    ]);
    expect(workspace.findUnique).not.toHaveBeenCalled();
  });

  /**
   * A guarded finish that matched a row returns that row; answered `null` regardless, the worker
   * reads its own terminal write as one somebody else had already made.
   */
  it('returns the row a guarded finish matched', async () => {
    const { client } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);

    await expect(
      repo.finish('run-1', {
        status: 'SUCCEEDED',
        usage: { inputTokens: 1, outputTokens: 2, stepCount: 1 },
      }),
    ).resolves.toMatchObject({ id: 'run-1' });
  });

  /** Every write of this repository names the entity whose row was missing. */
  it.each([
    [
      'recordPush',
      async (repo: PrismaJobRunRepository) =>
        repo.recordPush('run-1', { workBranch: 'agent/x', lastPushedSha: 'abc' }),
    ],
    ['setStatus', async (repo: PrismaJobRunRepository) => repo.setStatus('run-1', 'RUNNING')],
  ])('names the entity of a row %s could not find', async (_case, call) => {
    const missing = Object.assign(new Error('Record to update not found'), { code: 'P2025' });
    const { client } = fakePrisma({ update: vi.fn(() => Promise.reject(missing)) });
    const repo = new PrismaJobRunRepository(client, fakeRedactor);

    const failure = await call(repo).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotFoundError);
    expect((failure as NotFoundError).entity).toBe('JobRun');
  });

  /**
   * A run pointed at a workspace that is not there reports the workspace as missing, not the run:
   * the run exists and the caller's mistake is the id it supplied.
   */
  it('names the workspace when the workspace a run is attached to is gone', async () => {
    const { client, workspace } = fakePrisma();
    workspace.findUnique.mockResolvedValue(null);
    const repo = new PrismaJobRunRepository(client, fakeRedactor);

    const failure = await repo
      .setStatus('run-1', 'RUNNING', { workspaceId: 'ws-gone' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotFoundError);
    expect((failure as NotFoundError).entity).toBe('Workspace');
  });

  /** A create that finds no row of its own reports the run rather than the job it belongs to. */
  it('names the run when a create finds no row of its own', async () => {
    const missing = Object.assign(new Error('Record not found'), { code: 'P2025' });
    const { client } = fakePrisma({ create: vi.fn(() => Promise.reject(missing)) });
    const repo = new PrismaJobRunRepository(client, fakeRedactor);

    const failure = await repo
      .create({ jobId: 'job-1', model: 'gpt', scheduledFor: new Date(), trigger: 'SCHEDULE' })
      .catch((error: unknown) => error);

    expect((failure as NotFoundError).entity).toBe('JobRun');
  });
});
