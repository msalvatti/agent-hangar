/**
 * `@db` integration suite for `PrismaJobRunRepository`, against a real Postgres.
 *
 * Layer: integration.
 * Goal: `create` starts QUEUED with `scheduledFor`; attaching the same workspace to two runs
 * (via `setStatus`'s `workspaceId`) throws `UniqueViolationError('JobRun', 'workspaceId')`;
 * `setStatus('PREPARING')` stamps `startedAt` and a later status leaves it alone; `finish` redacts canaries in `output`/`error`;
 * `findRunningByJob` finds the running run and returns null after it finishes; `listByJob` orders
 * newest first; deleting a run's workspace nulls `workspaceId` (SetNull); `create` on a missing
 * scheduled job raises `NotFoundError('ScheduledJob', …)`; a `setStatus` whose status update
 * fails rolls the `startedAt` stamp back with it. The shared conditional-`finish` contract runs
 * against this implementation too, so "the first outcome is the record" is pinned here and on the
 * double from one source, and so does the workspace-kind contract, so "a run's workspace is a job
 * workspace" is pinned the same way.
 * Mocks: none — a real compose Postgres.
 */
import { beforeEach, expect, it } from 'vitest';

import type { Redactor } from '../../secrets/types.ts';
import { GITHUB_CANARY, OPENAI_CANARY } from '../../testing/canaries.ts';
import type { PrismaClient } from '../generated/client.ts';
import { connectTestDb, describeDb, rawSelect, sqlTemplate, truncateAll } from '../testing/db.ts';
import { describeJobRunPushContract } from '../testing/job-run-push-contract.ts';
import { describeRunFinishContract } from '../testing/run-finish-contract.ts';
import { describeRunWorkspaceKindContract } from '../testing/run-workspace-kind-contract.ts';

import { NotFoundError, UniqueViolationError } from './errors.ts';
import { PrismaJobRunRepository } from './job-run.repository.ts';

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

  /**
   * Postgres reports a missing scheduled job as a foreign-key violation (P2003), not P2025, so
   * the translator must map that code; the in-memory double raises `NotFoundError` here.
   */
  it('create() on a missing scheduled job throws NotFoundError naming the job', async () => {
    const repo = new PrismaJobRunRepository(client, testRedactor);
    let caught: unknown;
    try {
      await repo.create({
        jobId: 'no-such-job',
        trigger: 'MANUAL',
        model: 'gpt-5.6-sol',
        scheduledFor: new Date(),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect((caught as NotFoundError).entity).toBe('ScheduledJob');
    expect((caught as NotFoundError).id).toBe('no-such-job');
  });

  /**
   * The guarded `startedAt` stamp and the status update share one transaction: a PREPARING that
   * attaches an already-taken workspace must fail without leaving a QUEUED run that looks started.
   */
  it('setStatus() rolls the startedAt stamp back when the status update fails', async () => {
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
    const taken = await repo.create({
      jobId,
      trigger: 'MANUAL',
      model: 'gpt-5.6-sol',
      scheduledFor: new Date(),
    });
    await repo.setStatus(taken.id, 'RUNNING', { workspaceId: workspace.id });
    const run = await repo.create({
      jobId,
      trigger: 'MANUAL',
      model: 'gpt-5.6-sol',
      scheduledFor: new Date(),
    });
    await expect(
      repo.setStatus(run.id, 'PREPARING', { workspaceId: workspace.id }),
    ).rejects.toBeInstanceOf(UniqueViolationError);
    const rows = await rawSelect<{ startedAt: Date | null; status: string }>(
      client,
      sqlTemplate('SELECT "startedAt", status FROM "JobRun" WHERE id = '),
      run.id,
    );
    expect(rows[0]?.startedAt).toBeNull();
    expect(rows[0]?.status).toBe('QUEUED');
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
      sqlTemplate('SELECT output, error FROM "JobRun" WHERE id = '),
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

  describeJobRunPushContract('PrismaJobRunRepository', {
    seed: async () => {
      const run = await new PrismaJobRunRepository(client, testRedactor).create({
        jobId,
        trigger: 'SCHEDULE',
        model: 'gpt-5.6-sol',
        scheduledFor: new Date(),
      });
      return run.id;
    },
    recordPush: async (id, push) => {
      await new PrismaJobRunRepository(client, testRedactor).recordPush(id, push);
    },
    pushOf: async (id) => {
      const run = await new PrismaJobRunRepository(client, testRedactor).get(id);
      return run === null ? null : { workBranch: run.workBranch, lastPushedSha: run.lastPushedSha };
    },
    recordPushOnMissing: async (id) => {
      try {
        await new PrismaJobRunRepository(client, testRedactor).recordPush(id, {
          workBranch: 'agent/job-x',
          lastPushedSha: 'deadbeefdeadbeef',
        });
        return null;
      } catch (error) {
        return error;
      }
    },
  });

  describeRunFinishContract('PrismaJobRunRepository', {
    seed: async (status) => {
      const repo = new PrismaJobRunRepository(client, testRedactor);
      const run = await repo.create({
        jobId,
        trigger: 'SCHEDULE',
        model: 'gpt-5.6-sol',
        scheduledFor: new Date(),
      });
      return status === 'QUEUED' ? run.id : (await repo.setStatus(run.id, status)).id;
    },
    finish: async (id, status) =>
      (await new PrismaJobRunRepository(client, testRedactor).finish(id, {
        status,
        usage: { inputTokens: 0, outputTokens: 0, stepCount: 0 },
      })) !== null,
    statusOf: async (id) =>
      (await new PrismaJobRunRepository(client, testRedactor).get(id))?.status ?? null,
  });

  describeRunWorkspaceKindContract('PrismaJobRunRepository', {
    seedRun: async () => {
      const run = await new PrismaJobRunRepository(client, testRedactor).create({
        jobId,
        trigger: 'SCHEDULE',
        model: 'gpt-5.6-sol',
        scheduledFor: new Date(),
      });
      return run.id;
    },
    seedWorkspace: async (kind) => {
      const chat =
        kind === 'CHAT'
          ? await client.chat.create({
              data: {
                title: 'Owner of the shared workspace',
                repoUrl: 'https://github.com/acme/repo',
                baseBranch: 'main',
              },
            })
          : null;
      const workspace = await client.workspace.create({
        data: {
          kind,
          chatId: chat?.id ?? null,
          runnerKind: 'docker',
          image: 'agent-hangar/workspace:dev',
          repoUrl: 'https://github.com/acme/repo',
          branch: 'main',
        },
      });
      return workspace.id;
    },
    attach: async (runId, workspaceId) => {
      await new PrismaJobRunRepository(client, testRedactor).setStatus(runId, 'PREPARING', {
        workspaceId,
      });
    },
    workspaceIdOf: async (runId) =>
      (await new PrismaJobRunRepository(client, testRedactor).get(runId))?.workspaceId ?? null,
  });
});
