/**
 * `@db` cross-repository invariant suite, against a real Postgres.
 *
 * Layer: integration.
 * Goal: proves, in one place, the guarantees every individual repository suite exercises in
 * isolation: a canary written through any redacted column never reaches the raw row, cascades
 * flow end to end across the whole schema, and `createRepositories` produces the same shape as
 * `createInMemoryRepositories` — the invariant W2-A/W2-B rely on to swap fakes for the real thing.
 * Mocks: none — a real compose Postgres. Uses a minimal inline `Redactor` (see file header of
 * each repository test) so this suite does not depend on W1-A's implementation landing first.
 */
import { beforeEach, expect, it } from 'vitest';

import type { Redactor } from '../../secrets/types.ts';
import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '../../testing/canaries.ts';
import { FakeClock } from '../../testing/fake-clock.ts';
import { createInMemoryRepositories } from '../../testing/in-memory-repositories.ts';
import type { PrismaClient } from '../generated/client.ts';
import {
  connectTestDb,
  describeDb,
  rawSelect,
  seedChat,
  sqlTemplate,
  truncateAll,
} from '../testing/db.ts';

import { createRepositories } from './index.ts';

const BOTH_CANARIES = `${GITHUB_CANARY} and ${OPENAI_CANARY}`;

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

/**
 * Writes a canary into every redacted column, one per repository, and returns the raw stored
 * value of each — so the test body only has to assert, not orchestrate eight repositories.
 *
 * @param repos - Repositories under test.
 */
async function writeCanaryThroughEveryRepository(
  repos: ReturnType<typeof createRepositories>,
): Promise<(string | undefined)[]> {
  const chat = await repos.chats.create({
    title: 'X',
    repoUrl: 'https://github.com/acme/repo',
    baseBranch: 'main',
  });
  const message = await repos.messages.append(chat.id, 'USER', BOTH_CANARIES);
  const turn = await repos.turns.create({ chatId: chat.id, model: 'gpt-5.6-sol' });
  await repos.turns.finish(
    turn.id,
    'FAILED',
    { inputTokens: 0, outputTokens: 0, stepCount: 1 },
    BOTH_CANARIES,
  );
  const workspace = await repos.workspaces.create({
    kind: 'CHAT',
    chatId: chat.id,
    runnerKind: 'docker',
    image: 'agent-hangar/workspace:dev',
    repoUrl: 'https://github.com/acme/repo',
    branch: 'main',
  });
  await repos.workspaces.setStatus(workspace.id, 'FAILED', { failureReason: BOTH_CANARIES });
  const job = await repos.scheduledJobs.create({
    name: 'Nightly',
    cron: '0 0 * * *',
    timezone: 'UTC',
    prompt: 'print date',
    repoUrl: 'https://github.com/acme/repo',
    branch: 'main',
    enabled: true,
  });
  const run = await repos.jobRuns.create({
    jobId: job.id,
    trigger: 'MANUAL',
    model: 'gpt-5.6-sol',
    scheduledFor: new Date(),
  });
  await repos.jobRuns.finish(run.id, {
    status: 'FAILED',
    usage: { inputTokens: 0, outputTokens: 0, stepCount: 1 },
    output: BOTH_CANARIES,
    error: BOTH_CANARIES,
  });
  const toolCall = await repos.toolCalls.start({
    workspaceId: workspace.id,
    turnId: turn.id,
    callId: 'call-1',
    seq: 1,
    toolName: 'run_shell',
    args: { command: `echo ${GITHUB_CANARY} ${OPENAI_CANARY}` },
  });
  await repos.toolCalls.finish(toolCall.id, {
    status: 'SUCCEEDED',
    exitCode: 0,
    resultHead: BOTH_CANARIES,
    resultBytes: BOTH_CANARIES.length,
    durationMs: 1,
  });

  const messageRow = await rawSelect<{ content: string }>(
    client,
    sqlTemplate('SELECT content FROM "Message" WHERE id = '),
    message.id,
  );
  const turnRow = await rawSelect<{ error: string }>(
    client,
    sqlTemplate('SELECT error FROM "Turn" WHERE id = '),
    turn.id,
  );
  const workspaceRow = await rawSelect<{ failureReason: string }>(
    client,
    sqlTemplate('SELECT "failureReason" FROM "Workspace" WHERE id = '),
    workspace.id,
  );
  const jobRunRow = await rawSelect<{ output: string; error: string }>(
    client,
    sqlTemplate('SELECT output, error FROM "JobRun" WHERE id = '),
    run.id,
  );
  const toolCallRow = await rawSelect<{ args: string; resultHead: string }>(
    client,
    sqlTemplate('SELECT args::text AS args, "resultHead" FROM "ToolCallLog" WHERE id = '),
    toolCall.id,
  );

  return [
    messageRow[0]?.content,
    turnRow[0]?.error,
    workspaceRow[0]?.failureReason,
    jobRunRow[0]?.output,
    jobRunRow[0]?.error,
    toolCallRow[0]?.args,
    toolCallRow[0]?.resultHead,
  ];
}

describeDb('persistence invariants', () => {
  beforeEach(async () => {
    client = connectTestDb();
    await truncateAll(client);
  });

  /**
   * Every redacted column, written through its own repository, is `[REDACTED]` in the raw row —
   * a canary never survives to storage, whichever repository wrote it.
   */
  it('redacts a canary written through any repository, never leaking it to a raw row', async () => {
    const repos = createRepositories(client, testRedactor);
    const values = await writeCanaryThroughEveryRepository(repos);
    for (const value of values) {
      expect(value).toBeDefined();
      const text = value ?? '';
      assertNoCanary(text);
      expect(text).toContain('[REDACTED]');
    }
  });

  /** Chat → Turn/ToolCallLog cascade; the chat's workspace survives with chatId nulled. */
  it('deleting a Chat cascades Messages/Turns/their ToolCallLogs and nulls its Workspace chatId', async () => {
    const repos = createRepositories(client, testRedactor);
    const chatId = await seedChat(client);
    await repos.messages.append(chatId, 'USER', 'hi');
    const turn = await repos.turns.create({ chatId, model: 'gpt-5.6-sol' });
    // Finished first: the delete refuses while a turn of the chat is live, and the cascade this
    // test is about is the same whichever terminal status the turn holds.
    await repos.turns.finish(turn.id, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    const workspace = await repos.workspaces.create({
      kind: 'CHAT',
      chatId,
      runnerKind: 'docker',
      image: 'agent-hangar/workspace:dev',
      repoUrl: 'https://github.com/acme/repo',
      branch: 'main',
    });
    await repos.toolCalls.start({
      workspaceId: workspace.id,
      turnId: turn.id,
      callId: 'call-1',
      seq: 1,
      toolName: 'run_shell',
      args: {},
    });
    expect(await repos.chats.deleteIfIdle(chatId)).toBe('DELETED');
    expect(await client.message.count()).toBe(0);
    expect(await client.turn.count()).toBe(0);
    expect(await client.toolCallLog.count({ where: { turnId: turn.id } })).toBe(0);
    const survivingWorkspace = await client.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
    });
    expect(survivingWorkspace.chatId).toBeNull();
  });

  /** ScheduledJob → JobRun → ToolCallLog cascade. */
  it('deleting a ScheduledJob cascades JobRuns and their ToolCallLogs', async () => {
    const repos = createRepositories(client, testRedactor);
    const job = await repos.scheduledJobs.create({
      name: 'Nightly',
      cron: '0 0 * * *',
      timezone: 'UTC',
      prompt: 'print date',
      repoUrl: 'https://github.com/acme/repo',
      branch: 'main',
      enabled: true,
    });
    const workspace = await repos.workspaces.create({
      kind: 'JOB',
      runnerKind: 'docker',
      image: 'agent-hangar/workspace:dev',
      repoUrl: 'https://github.com/acme/repo',
      branch: 'main',
    });
    const run = await repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: 'gpt-5.6-sol',
      scheduledFor: new Date(),
    });
    await repos.toolCalls.start({
      workspaceId: workspace.id,
      jobRunId: run.id,
      callId: 'call-1',
      seq: 1,
      toolName: 'run_shell',
      args: {},
    });
    await repos.scheduledJobs.delete(job.id);
    expect(await client.jobRun.count()).toBe(0);
    expect(await client.toolCallLog.count({ where: { jobRunId: run.id } })).toBe(0);
  });

  /** Deleting a Workspace removes its ToolCallLogs and nulls Turn/JobRun workspaceId. */
  it('deleting a Workspace removes its ToolCallLogs and nulls Turn/JobRun workspaceId', async () => {
    const repos = createRepositories(client, testRedactor);
    const chatId = await seedChat(client);
    const workspace = await repos.workspaces.create({
      kind: 'CHAT',
      chatId,
      runnerKind: 'docker',
      image: 'agent-hangar/workspace:dev',
      repoUrl: 'https://github.com/acme/repo',
      branch: 'main',
    });
    const turn = await repos.turns.create({ chatId, model: 'gpt-5.6-sol' });
    await repos.turns.setStatus(turn.id, 'RUNNING', { workspaceId: workspace.id });
    const job = await repos.scheduledJobs.create({
      name: 'Nightly',
      cron: '0 0 * * *',
      timezone: 'UTC',
      prompt: 'print date',
      repoUrl: 'https://github.com/acme/repo',
      branch: 'main',
      enabled: true,
    });
    const run = await repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: 'gpt-5.6-sol',
      scheduledFor: new Date(),
    });
    await repos.jobRuns.setStatus(run.id, 'RUNNING', { workspaceId: workspace.id });
    await repos.toolCalls.start({
      workspaceId: workspace.id,
      turnId: turn.id,
      callId: 'call-1',
      seq: 1,
      toolName: 'run_shell',
      args: {},
    });
    await client.workspace.delete({ where: { id: workspace.id } });
    expect(await client.toolCallLog.count({ where: { workspaceId: workspace.id } })).toBe(0);
    const reloadedTurn = await repos.turns.get(turn.id);
    const reloadedRun = await repos.jobRuns.get(run.id);
    expect(reloadedTurn?.workspaceId).toBeNull();
    expect(reloadedRun?.workspaceId).toBeNull();
  });

  /** createRepositories(prisma, redactor) has the same key shape as createInMemoryRepositories(). */
  it('createRepositories() has the same key shape as createInMemoryRepositories()', () => {
    const prismaRepos = createRepositories(client, testRedactor);
    const inMemory = createInMemoryRepositories(new FakeClock());
    const { store: _store, ...inMemoryPorts } = inMemory;
    expect(Object.keys(prismaRepos).sort()).toEqual(Object.keys(inMemoryPorts).sort());
  });
});
