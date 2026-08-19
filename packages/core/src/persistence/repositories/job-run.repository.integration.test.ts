/**
 * `@db` integration suite for `PrismaJobRunRepository`, against a real Postgres.
 *
 * Layer: integration.
 * Goal: `create` starts QUEUED with `scheduledFor`; attaching the same workspace to two runs
 * (via `setStatus`'s `workspaceId`) throws `UniqueViolationError('JobRun', 'workspaceId')`;
 * `setStatus('RUNNING')` stamps `startedAt`; `finish` redacts canaries in `output`/`error`;
 * `findRunningByJob` finds the running run and returns null after it finishes; `listByJob` orders
 * newest first; deleting a run's workspace nulls `workspaceId` (SetNull).
 * Mocks: none — a real compose Postgres.
 */
import { beforeEach, expect, it } from 'vitest';

import type { Redactor } from '../../secrets/types.js';
import { GITHUB_CANARY, OPENAI_CANARY } from '../../testing/canaries.js';
import type { PrismaClient } from '../generated/client.js';
import { connectTestDb, describeDb, rawSelect, truncateAll } from '../testing/db.js';

import { UniqueViolationError } from './errors.js';
import { PrismaJobRunRepository } from './job-run.repository.js';

const testRedactor: Redactor = {
  register: () => undefined,
  redact: (input: string) =>
    input.replaceAll(GITHUB_CANARY, '[REDACTED]').replaceAll(OPENAI_CANARY, '[REDACTED]'),
  redactJson: (input: unknown) => input,
};

let client: PrismaClient;
let jobId: string;

describeDb('PrismaJobRunRepository', () => {
  beforeEach(async () => {
    client = connectTestDb();
    await truncateAll(client);
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
    jobId = job.id;
  });

  /** create() starts QUEUED with scheduledFor set. */
  it('create() starts QUEUED with scheduledFor set', async () => {
    const repo = new PrismaJobRunRepository(client, testRedactor);
    const scheduledFor = new Date('2026-01-01T00:00:00.000Z');
    const run = await repo.create({
      jobId,
      trigger: 'SCHEDULE',
      model: 'gpt-5.6-sol',
      scheduledFor,
    });
    expect(run.status).toBe('QUEUED');
    expect(run.scheduledFor).toEqual(scheduledFor);
  });

  /** Attaching the same workspace to two different runs throws UniqueViolationError. */
  it('attaching the same workspace to two runs throws UniqueViolationError', async () => {
    const repo = new PrismaJobRunRepository(client, testRedactor);
    const workspace = await client.workspace.create({
      data: {
        kind: 'JOB',
        runnerKind: 'docker',
        image: 'agent-hangar/workspace:dev',
        repoUrl: 'https://github.com/acme/repo',
        branch: 'main',
      },
    });
    const runA = await repo.create({
      jobId,
      trigger: 'MANUAL',
      model: 'gpt-5.6-sol',
      scheduledFor: new Date(),
    });
    const runB = await repo.create({
      jobId,
      trigger: 'MANUAL',
      model: 'gpt-5.6-sol',
      scheduledFor: new Date(),
    });
    await repo.setStatus(runA.id, 'RUNNING', { workspaceId: workspace.id });
    await expect(
      repo.setStatus(runB.id, 'RUNNING', { workspaceId: workspace.id }),
    ).rejects.toBeInstanceOf(UniqueViolationError);
  });

  /** setStatus(PREPARING) stamps startedAt (the same rule Turn follows: PREPARING only). */
  it('setStatus(PREPARING) stamps startedAt', async () => {
    const repo = new PrismaJobRunRepository(client, testRedactor);
    const run = await repo.create({
      jobId,
      trigger: 'MANUAL',
      model: 'gpt-5.6-sol',
      scheduledFor: new Date(),
    });
    const preparing = await repo.setStatus(run.id, 'PREPARING');
    expect(preparing.startedAt).not.toBeNull();
  });

  /** finish() redacts canaries in both output and error before the write. */
  it('finish(FAILED) redacts canaries in output and error', async () => {
    const repo = new PrismaJobRunRepository(client, testRedactor);
    const run = await repo.create({
      jobId,
      trigger: 'MANUAL',
      model: 'gpt-5.6-sol',
      scheduledFor: new Date(),
    });
    await repo.finish(run.id, {
      status: 'FAILED',
      usage: { inputTokens: 0, outputTokens: 0, stepCount: 1 },
      output: `partial: ${GITHUB_CANARY}`,
      error: `boom: ${OPENAI_CANARY}`,
    });
    const rows = await rawSelect<{ output: string; error: string }>(
      client,
      Object.assign(['SELECT output, error FROM "JobRun" WHERE id = ', ''], {
        raw: ['SELECT output, error FROM "JobRun" WHERE id = ', ''],
      }),
      run.id,
    );
    expect(rows[0]?.output).toContain('[REDACTED]');
    expect(rows[0]?.error).toContain('[REDACTED]');
    expect(rows[0]?.output).not.toContain(GITHUB_CANARY);
    expect(rows[0]?.error).not.toContain(OPENAI_CANARY);
  });

  /** findRunningByJob() finds the running run and returns null once it finishes. */
  it('findRunningByJob() finds the running run and null after it finishes', async () => {
    const repo = new PrismaJobRunRepository(client, testRedactor);
    const run = await repo.create({
      jobId,
      trigger: 'MANUAL',
      model: 'gpt-5.6-sol',
      scheduledFor: new Date(),
    });
    await repo.setStatus(run.id, 'RUNNING');
    expect((await repo.findRunningByJob(jobId))?.id).toBe(run.id);
    await repo.finish(run.id, {
      status: 'SUCCEEDED',
      usage: { inputTokens: 0, outputTokens: 0, stepCount: 1 },
    });
    expect(await repo.findRunningByJob(jobId)).toBeNull();
  });

  /** listByJob() orders newest first. */
  it('listByJob() orders newest first', async () => {
    const repo = new PrismaJobRunRepository(client, testRedactor);
    const first = await repo.create({
      jobId,
      trigger: 'MANUAL',
      model: 'gpt-5.6-sol',
      scheduledFor: new Date(),
    });
    const second = await repo.create({
      jobId,
      trigger: 'MANUAL',
      model: 'gpt-5.6-sol',
      scheduledFor: new Date(),
    });
    const runs = await repo.listByJob(jobId);
    expect(runs.map((r) => r.id)).toEqual([second.id, first.id]);
  });

  /** Deleting a run's workspace nulls workspaceId (SetNull). */
  it('deleting the workspace nulls workspaceId', async () => {
    const repo = new PrismaJobRunRepository(client, testRedactor);
    const workspace = await client.workspace.create({
      data: {
        kind: 'JOB',
        runnerKind: 'docker',
        image: 'agent-hangar/workspace:dev',
        repoUrl: 'https://github.com/acme/repo',
        branch: 'main',
      },
    });
    const run = await repo.create({
      jobId,
      trigger: 'MANUAL',
      model: 'gpt-5.6-sol',
      scheduledFor: new Date(),
    });
    await repo.setStatus(run.id, 'RUNNING', { workspaceId: workspace.id });
    await client.workspace.delete({ where: { id: workspace.id } });
    const reloaded = await repo.get(run.id);
    expect(reloaded?.workspaceId).toBeNull();
  });
});
