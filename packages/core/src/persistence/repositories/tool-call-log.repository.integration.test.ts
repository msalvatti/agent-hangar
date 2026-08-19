/**
 * `@db` integration suite for `PrismaToolCallLogRepository`, against a real Postgres.
 *
 * Layer: integration.
 * Goal: `start` records RUNNING with redacted `args` (verified against the raw JSON text, not the
 * mapper); `finish` truncates `resultHead` to the byte budget while `resultBytes` keeps the full
 * length, and redacts a canary in `resultHead`; `listByTurn`/`listByJobRun` partition correctly
 * and order by `seq` asc; an unknown id throws `NotFoundError`.
 * Mocks: none — a real compose Postgres.
 */
import { beforeEach, expect, it } from 'vitest';

import type { Redactor } from '../../secrets/types.js';
import { GITHUB_CANARY, OPENAI_CANARY } from '../../testing/canaries.js';
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
import { RESULT_HEAD_MAX_BYTES } from './mappers.js';
import { PrismaToolCallLogRepository } from './tool-call-log.repository.js';

const testRedactor: Redactor = {
  register: () => undefined,
  redact: (input: string) =>
    input.replaceAll(GITHUB_CANARY, '[REDACTED]').replaceAll(OPENAI_CANARY, '[REDACTED]'),
  redactJson: (input: unknown) =>
    JSON.parse(
      JSON.stringify(input)
        .replaceAll(GITHUB_CANARY, '[REDACTED]')
        .replaceAll(OPENAI_CANARY, '[REDACTED]'),
    ) as unknown,
};

let client: PrismaClient;
let workspaceId: string;
let turnId: string;
let jobRunId: string;

describeDb('PrismaToolCallLogRepository', () => {
  beforeEach(async () => {
    client = connectTestDb();
    await truncateAll(client);
    const chatId = await seedChat(client);
    const workspace = await client.workspace.create({
      data: {
        kind: 'CHAT',
        chatId,
        runnerKind: 'docker',
        image: 'agent-hangar/workspace:dev',
        repoUrl: 'https://github.com/acme/repo',
        branch: 'main',
      },
    });
    workspaceId = workspace.id;
    const turn = await client.turn.create({ data: { chatId, model: 'gpt-5.6-sol' } });
    turnId = turn.id;
    const job = await client.scheduledJob.create({
      data: {
        name: 'Nightly',
        cron: '0 0 * * *',
        timezone: 'UTC',
        prompt: 'print date',
        repoUrl: 'https://github.com/acme/repo',
        branch: 'main',
      },
    });
    const run = await client.jobRun.create({
      data: { jobId: job.id, trigger: 'MANUAL', model: 'gpt-5.6-sol', scheduledFor: new Date() },
    });
    jobRunId = run.id;
  });

  /** start() records RUNNING with args redacted before the write. */
  it('start() records RUNNING and redacts a canary inside args', async () => {
    const repo = new PrismaToolCallLogRepository(client, testRedactor);
    const log = await repo.start({
      workspaceId,
      turnId,
      callId: 'call-1',
      seq: 1,
      toolName: 'run_shell',
      args: { command: `echo ${GITHUB_CANARY}` },
    });
    expect(log.status).toBe('RUNNING');
    const rows = await rawSelect<{ args: string }>(
      client,
      sqlTemplate('SELECT args::text AS args FROM "ToolCallLog" WHERE id = '),
      log.id,
    );
    expect(rows[0]?.args).toContain('[REDACTED]');
    expect(rows[0]?.args).not.toContain(GITHUB_CANARY);
  });

  /** finish() truncates a large resultHead while keeping the full length in resultBytes. */
  it('finish() truncates resultHead to the byte budget and keeps the full length', async () => {
    const repo = new PrismaToolCallLogRepository(client, testRedactor);
    const log = await repo.start({
      workspaceId,
      turnId,
      callId: 'call-2',
      seq: 1,
      toolName: 'read_file',
      args: {},
    });
    const original = 'x'.repeat(RESULT_HEAD_MAX_BYTES + 20 * 1024);
    const finished = await repo.finish(log.id, {
      status: 'SUCCEEDED',
      exitCode: 0,
      resultHead: original,
      resultBytes: original.length,
      durationMs: 5,
    });
    expect(finished.resultHead?.length).toBeLessThanOrEqual(RESULT_HEAD_MAX_BYTES);
    expect(finished.resultBytes).toBe(original.length);
  });

  /** finish() redacts a canary inside resultHead. */
  it('finish() redacts a canary inside resultHead', async () => {
    const repo = new PrismaToolCallLogRepository(client, testRedactor);
    const log = await repo.start({
      workspaceId,
      turnId,
      callId: 'call-3',
      seq: 1,
      toolName: 'read_file',
      args: {},
    });
    const finished = await repo.finish(log.id, {
      status: 'SUCCEEDED',
      exitCode: 0,
      resultHead: `token=${OPENAI_CANARY}`,
      resultBytes: 20,
      durationMs: 1,
    });
    expect(finished.resultHead).toContain('[REDACTED]');
    expect(finished.resultHead).not.toContain(OPENAI_CANARY);
  });

  /** finish(TIMED_OUT) allows a null exitCode. */
  it('finish(TIMED_OUT) allows a null exitCode', async () => {
    const repo = new PrismaToolCallLogRepository(client, testRedactor);
    const log = await repo.start({
      workspaceId,
      turnId,
      callId: 'call-4',
      seq: 1,
      toolName: 'run_shell',
      args: {},
    });
    const finished = await repo.finish(log.id, {
      status: 'TIMED_OUT',
      exitCode: null,
      resultHead: null,
      resultBytes: null,
      durationMs: 60000,
    });
    expect(finished.exitCode).toBeNull();
    expect(finished.status).toBe('TIMED_OUT');
  });

  /** listByTurn()/listByJobRun() partition by parent and order by seq asc. */
  it('listByTurn() and listByJobRun() partition by parent, ordered by seq asc', async () => {
    const repo = new PrismaToolCallLogRepository(client, testRedactor);
    const turnLog1 = await repo.start({
      workspaceId,
      turnId,
      callId: 'call-t1',
      seq: 1,
      toolName: 'run_shell',
      args: {},
    });
    const turnLog2 = await repo.start({
      workspaceId,
      turnId,
      callId: 'call-t2',
      seq: 2,
      toolName: 'run_shell',
      args: {},
    });
    const jobLog = await repo.start({
      workspaceId,
      jobRunId,
      callId: 'call-j1',
      seq: 1,
      toolName: 'run_shell',
      args: {},
    });
    const byTurn = await repo.listByTurn(turnId);
    expect(byTurn.map((l) => l.id)).toEqual([turnLog1.id, turnLog2.id]);
    const byJobRun = await repo.listByJobRun(jobRunId);
    expect(byJobRun.map((l) => l.id)).toEqual([jobLog.id]);
  });

  /** finish() on an unknown id throws NotFoundError. */
  it('finish() throws NotFoundError for an unknown id', async () => {
    const repo = new PrismaToolCallLogRepository(client, testRedactor);
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
});
