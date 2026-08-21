/**
 * The shared port contracts, run against the in-memory doubles.
 *
 * Layer: unit.
 * Goal: the rules a conditional write owes every caller are written once, in
 * `persistence/testing/*-contract.ts`, and asserted against both implementations of each port —
 * the double here, the Prisma repository in its own `@db` suite. Two implementations that each had
 * their own tests is exactly how they came to agree on being wrong, so neither is allowed a
 * specification of its own.
 * Mocks: FakeClock, through the in-memory repositories.
 */
import { beforeEach } from 'vitest';

import { describeChatDeleteContract } from '../persistence/testing/chat-delete-contract.ts';
import { describeJobRunPushContract } from '../persistence/testing/job-run-push-contract.ts';
import { describeRunFinishContract } from '../persistence/testing/run-finish-contract.ts';
import { describeRunWorkspaceKindContract } from '../persistence/testing/run-workspace-kind-contract.ts';

import { FakeClock } from './fake-clock.ts';
import { createInMemoryRepositories } from './in-memory-repositories.ts';
import type { InMemoryRepositories } from './in-memory-repositories.ts';

const T0 = new Date('2026-08-19T10:00:00.000Z');

let repos: InMemoryRepositories;

beforeEach(() => {
  repos = createInMemoryRepositories(new FakeClock(T0));
});

/**
 * Creates a chat with the fields every contract test needs and nothing else.
 *
 * @returns The chat.
 */
async function seedChat() {
  return repos.chats.create({
    title: 'Fix tests',
    repoUrl: 'https://github.com/acme/w',
    baseBranch: 'main',
  });
}

/**
 * Creates an enabled scheduled job for the run contracts to hang a run from.
 *
 * @returns The job.
 */
async function seedJob() {
  return repos.scheduledJobs.create({
    name: 'nightly',
    cron: '0 3 * * *',
    timezone: 'UTC',
    prompt: 'lint',
    repoUrl: 'https://github.com/acme/w',
    branch: 'main',
    enabled: true,
  });
}

describeChatDeleteContract('InMemoryChatRepository', {
  repository: () => repos.chats,
  seed: () =>
    repos.chats.create({ title: 'X', repoUrl: 'https://github.com/a/a', baseBranch: 'main' }),
  addTurn: async (chatId, status) => {
    const turn = await repos.turns.create({ chatId, model: 'm' });
    await repos.turns.setStatus(turn.id, status);
  },
});

describeRunFinishContract('InMemoryTurnRepository', {
  seed: async (status) => {
    const chat = await seedChat();
    const turn = await repos.turns.create({ chatId: chat.id, model: 'm' });
    return status === 'QUEUED' ? turn.id : (await repos.turns.setStatus(turn.id, status)).id;
  },
  finish: async (id, status) =>
    (await repos.turns.finish(id, status, { inputTokens: 0, outputTokens: 0, stepCount: 0 })) !==
    null,
  statusOf: async (id) => (await repos.turns.get(id))?.status ?? null,
});

describeJobRunPushContract('InMemoryJobRunRepository', {
  seed: async () => {
    const job = await seedJob();
    const run = await repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'm',
      scheduledFor: T0,
    });
    return run.id;
  },
  recordPush: async (id, push) => {
    await repos.jobRuns.recordPush(id, push);
  },
  pushOf: async (id) => {
    const run = await repos.jobRuns.get(id);
    return run === null ? null : { workBranch: run.workBranch, lastPushedSha: run.lastPushedSha };
  },
  recordPushOnMissing: async (id) => {
    try {
      await repos.jobRuns.recordPush(id, {
        workBranch: 'agent/job-x',
        lastPushedSha: 'deadbeefdeadbeef',
      });
      return null;
    } catch (error) {
      return error;
    }
  },
});

describeRunFinishContract('InMemoryJobRunRepository', {
  seed: async (status) => {
    const job = await seedJob();
    const run = await repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'm',
      scheduledFor: T0,
    });
    return status === 'QUEUED' ? run.id : (await repos.jobRuns.setStatus(run.id, status)).id;
  },
  finish: async (id, status) =>
    (await repos.jobRuns.finish(id, {
      status,
      usage: { inputTokens: 0, outputTokens: 0, stepCount: 0 },
    })) !== null,
  statusOf: async (id) => (await repos.jobRuns.get(id))?.status ?? null,
});

describeRunWorkspaceKindContract('InMemoryJobRunRepository', {
  seedRun: async () => {
    const job = await seedJob();
    const run = await repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'm',
      scheduledFor: T0,
    });
    return run.id;
  },
  seedWorkspace: async (kind) => {
    const chat = kind === 'CHAT' ? await seedChat() : null;
    const workspace = await repos.workspaces.create({
      kind,
      ...(chat === null ? {} : { chatId: chat.id }),
      runnerKind: 'fake',
      image: 'image',
      repoUrl: 'https://github.com/acme/w',
      branch: 'main',
    });
    return workspace.id;
  },
  attach: async (runId, workspaceId) => {
    await repos.jobRuns.setStatus(runId, 'PREPARING', { workspaceId });
  },
  workspaceIdOf: async (runId) => (await repos.jobRuns.get(runId))?.workspaceId ?? null,
});
