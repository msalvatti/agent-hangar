/**
 * Unit tests for `PrismaToolCallLogRepository`.
 *
 * Layer: unit.
 * Goal: `start` requires exactly one of `turnId`/`jobRunId` (both or neither throws
 * `PersistenceMappingError` before any write), redacts `args` as JSON; `finish` redacts and
 * truncates a non-null `resultHead`, passes null through unchanged, and translates a missing row;
 * `listByTurn`/`listByJobRun` order by `seq` asc.
 * Mocks: a Prisma client double exposing only `toolCallLog.*` — no database.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Redactor } from '../../secrets/types.ts';
import type { PrismaClient } from '../generated/client.ts';

import { NotFoundError, PersistenceMappingError } from './errors.ts';
import { PrismaToolCallLogRepository } from './tool-call-log.repository.ts';

/** Builds a P2025 (record not found) error shaped like `PrismaClientKnownRequestError`. */
function p2025(): Error & { code: string } {
  return Object.assign(new Error('Record not found'), { code: 'P2025' });
}

const NOW = new Date('2026-01-01T00:00:00.000Z');

const logRow = {
  id: 'tc-1',
  workspaceId: 'ws-1',
  turnId: 'turn-1',
  jobRunId: null,
  callId: 'call-1',
  seq: 1,
  toolName: 'run_shell',
  args: { command: 'ls' },
  resultHead: null,
  resultBytes: null,
  exitCode: null,
  status: 'RUNNING',
  startedAt: NOW,
  finishedAt: null,
  durationMs: null,
};

const fakeRedactor: Redactor = {
  register: vi.fn(),
  redact: vi.fn((value: string) => `[REDACTED:${value}]`),
  redactJson: vi.fn((value: unknown) => value),
};

function fakePrisma(overrides: { update?: ReturnType<typeof vi.fn> } = {}) {
  const toolCallLog = {
    create: vi.fn(() => Promise.resolve(logRow)),
    update: overrides.update ?? vi.fn(() => Promise.resolve(logRow)),
    findMany: vi.fn(() => Promise.resolve([logRow])),
  };
  return { client: { toolCallLog } as unknown as PrismaClient, toolCallLog };
}

describe('PrismaToolCallLogRepository', () => {
  /** start() records a RUNNING row parented by a turn, redacting args. */
  it('start() records a RUNNING row parented by a turn', async () => {
    const { client, toolCallLog } = fakePrisma();
    const repo = new PrismaToolCallLogRepository(client, fakeRedactor);
    await repo.start({
      workspaceId: 'ws-1',
      turnId: 'turn-1',
      callId: 'call-1',
      seq: 1,
      toolName: 'run_shell',
      args: { command: 'ls' },
    });
    expect(toolCallLog.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws-1',
        turnId: 'turn-1',
        jobRunId: null,
        callId: 'call-1',
        seq: 1,
        toolName: 'run_shell',
        args: { command: 'ls' },
        status: 'RUNNING',
      },
    });
  });

  /** start() also accepts a jobRunId parent. */
  it('start() records a row parented by a job run', async () => {
    const { client, toolCallLog } = fakePrisma();
    const repo = new PrismaToolCallLogRepository(client, fakeRedactor);
    await repo.start({
      workspaceId: 'ws-1',
      jobRunId: 'run-1',
      callId: 'call-2',
      seq: 1,
      toolName: 'read_file',
      args: { path: 'a.txt' },
    });
    expect(toolCallLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ turnId: null, jobRunId: 'run-1' }) as object,
      }),
    );
  });

  /** Neither parent set is rejected before any write. */
  it('start() throws PersistenceMappingError when neither parent is set', async () => {
    const { client, toolCallLog } = fakePrisma();
    const repo = new PrismaToolCallLogRepository(client, fakeRedactor);
    await expect(
      repo.start({
        workspaceId: 'ws-1',
        callId: 'call-3',
        seq: 1,
        toolName: 'run_shell',
        args: {},
      }),
    ).rejects.toBeInstanceOf(PersistenceMappingError);
    expect(toolCallLog.create).not.toHaveBeenCalled();
  });

  /** Both parents set is equally rejected before any write. */
  it('start() throws PersistenceMappingError when both parents are set', async () => {
    const { client, toolCallLog } = fakePrisma();
    const repo = new PrismaToolCallLogRepository(client, fakeRedactor);
    await expect(
      repo.start({
        workspaceId: 'ws-1',
        turnId: 'turn-1',
        jobRunId: 'run-1',
        callId: 'call-4',
        seq: 1,
        toolName: 'run_shell',
        args: {},
      }),
    ).rejects.toBeInstanceOf(PersistenceMappingError);
    expect(toolCallLog.create).not.toHaveBeenCalled();
  });

  /** finish() redacts and truncates a non-null resultHead. */
  it('finish() redacts a non-null resultHead', async () => {
    const { client, toolCallLog } = fakePrisma();
    const repo = new PrismaToolCallLogRepository(client, fakeRedactor);
    await repo.finish('tc-1', {
      status: 'SUCCEEDED',
      exitCode: 0,
      resultHead: 'output text',
      resultBytes: 11,
      durationMs: 5,
    });
    expect(toolCallLog.update).toHaveBeenCalledWith({
      where: { id: 'tc-1' },
      data: {
        status: 'SUCCEEDED',
        exitCode: 0,
        resultBytes: 11,
        durationMs: 5,
        finishedAt: expect.any(Date) as Date,
        resultHead: '[REDACTED:output text]',
      },
    });
  });

  /** finish() passes a null resultHead through unchanged, never touching the redactor. */
  it('finish() passes a null resultHead through unchanged', async () => {
    const { client, toolCallLog } = fakePrisma();
    const repo = new PrismaToolCallLogRepository(client, fakeRedactor);
    await repo.finish('tc-1', {
      status: 'TIMED_OUT',
      exitCode: null,
      resultHead: null,
      resultBytes: null,
      durationMs: 60000,
    });
    expect(toolCallLog.update).toHaveBeenCalledWith({
      where: { id: 'tc-1' },
      data: {
        status: 'TIMED_OUT',
        exitCode: null,
        resultBytes: null,
        durationMs: 60000,
        finishedAt: expect.any(Date) as Date,
        resultHead: null,
      },
    });
  });

  /** finish() on a missing row translates P2025 to NotFoundError. */
  it('finish() translates a missing row to NotFoundError', async () => {
    const { client } = fakePrisma({ update: vi.fn(() => Promise.reject(p2025())) });
    const repo = new PrismaToolCallLogRepository(client, fakeRedactor);
    await expect(
      repo.finish('missing', {
        status: 'FAILED',
        exitCode: 1,
        resultHead: null,
        resultBytes: null,
        durationMs: 1,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  /** listByTurn()/listByJobRun() order by seq asc. */
  it('listByTurn() and listByJobRun() order by seq asc', async () => {
    const { client, toolCallLog } = fakePrisma();
    const repo = new PrismaToolCallLogRepository(client, fakeRedactor);
    await repo.listByTurn('turn-1');
    expect(toolCallLog.findMany).toHaveBeenCalledWith({
      where: { turnId: 'turn-1' },
      orderBy: { seq: 'asc' },
    });
    await repo.listByJobRun('run-1');
    expect(toolCallLog.findMany).toHaveBeenCalledWith({
      where: { jobRunId: 'run-1' },
      orderBy: { seq: 'asc' },
    });
  });
});

describe('what the tool-call log refuses and reports', () => {
  /**
   * A tool call hangs off exactly one parent — a turn or a scheduled run — and the message says
   * which field to fix. Emptied, the caller is told a mapping failed and nothing about what.
   */
  it.each([
    ['neither parent', {}],
    ['both parents', { turnId: 'turn-1', jobRunId: 'run-1' }],
  ])('refuses a start with %s, saying which fields it means', async (_case, parents) => {
    const { client } = fakePrisma();
    const repo = new PrismaToolCallLogRepository(client, fakeRedactor);

    await expect(
      repo.start({ callId: 'c1', seq: 0, toolName: 'run_shell', args: {}, ...parents }),
    ).rejects.toThrow('StartToolCallInput must set exactly one of turnId or jobRunId.');
  });

  /** A finish that finds no row names the entity whose row was missing. */
  it('names the entity of a row it could not finish', async () => {
    const { client } = fakePrisma({ update: vi.fn(() => Promise.reject(p2025())) });
    const repo = new PrismaToolCallLogRepository(client, fakeRedactor);

    const failure = await repo
      .finish('log-1', { status: 'SUCCEEDED', exitCode: 0, resultHead: null, resultBytes: 0 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NotFoundError);
    expect((failure as NotFoundError).entity).toBe('ToolCallLog');
  });
});
