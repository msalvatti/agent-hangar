/**
 * Unit tests for `PrismaJobRunRepository`.
 *
 * Layer: unit.
 * Goal: `create` starts a run QUEUED and translates a scheduled-job failure; `setStatus` stamps
 * `startedAt` only on PREPARING via a guarded `updateMany`, applies `workspaceId`/`error` only
 * when present, redacts a non-null `error`; `finish` redacts `output`/`error` only when provided
 * and leaves them untouched when omitted; `listByJob`/`findRunningByJob` build the expected
 * queries; failures translate through `translatePrismaError`.
 * Mocks: a Prisma client double exposing only `jobRun.*` — no database.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Redactor } from '../../secrets/types.js';
import type { PrismaClient } from '../generated/client.js';

import { NotFoundError, UniqueViolationError } from './errors.js';
import { PrismaJobRunRepository } from './job-run.repository.js';

/** Builds a P2025 (record not found) error shaped like `PrismaClientKnownRequestError`. */
function p2025(): Error & { code: string } {
  return Object.assign(new Error('Record not found'), { code: 'P2025' });
}

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
    update?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const jobRun = {
    create: overrides.create ?? vi.fn(() => Promise.resolve(runRow)),
    findFirst: vi.fn((): Promise<typeof runRow | null> => Promise.resolve(runRow)),
    findMany: vi.fn(() => Promise.resolve([runRow])),
    findUnique: vi.fn((): Promise<typeof runRow | null> => Promise.resolve(runRow)),
    updateMany: overrides.updateMany ?? vi.fn(() => Promise.resolve({ count: 1 })),
    update: overrides.update ?? vi.fn(() => Promise.resolve(runRow)),
  };
  return { client: { jobRun } as unknown as PrismaClient, jobRun };
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

  /** create() translates a missing scheduled job to NotFoundError. */
  it('create() translates a missing scheduled job to NotFoundError', async () => {
    const { client } = fakePrisma({ create: vi.fn(() => Promise.reject(p2025())) });
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    await expect(
      repo.create({ jobId: 'missing', trigger: 'MANUAL', model: 'gpt-5.6-sol', scheduledFor: NOW }),
    ).rejects.toBeInstanceOf(NotFoundError);
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

  /** finish() sets usage/finishedAt without output/error fields when both are omitted. */
  it('finish() omits output/error entirely when not provided', async () => {
    const { client, jobRun } = fakePrisma();
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    await repo.finish('run-1', {
      status: 'SUCCEEDED',
      usage: { inputTokens: 1, outputTokens: 2, stepCount: 1 },
    });
    expect(jobRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
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
    expect(jobRun.update).toHaveBeenLastCalledWith({
      where: { id: 'run-1' },
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
    expect(jobRun.update).toHaveBeenLastCalledWith({
      where: { id: 'run-1' },
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

  /** finish() translates a missing row to NotFoundError. */
  it('finish() translates a missing row to NotFoundError', async () => {
    const { client } = fakePrisma({ update: vi.fn(() => Promise.reject(p2025())) });
    const repo = new PrismaJobRunRepository(client, fakeRedactor);
    await expect(
      repo.finish('missing', {
        status: 'SUCCEEDED',
        usage: { inputTokens: 0, outputTokens: 0, stepCount: 0 },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
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
});
