/**
 * Unit tests for the in-memory repositories.
 *
 * Layer: unit.
 * Goal: every port method behaves like the Postgres implementation will — including the
 * invariants: gap-free message `seq`, one live workspace per chat, unique `JobRun.workspaceId`,
 * cascade deletes — with timestamps from the injected clock and copies (not live rows) returned.
 * Mocks: FakeClock.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { LiveWorkspaceExistsError, NotFoundError, UniqueViolationError } from '../errors.ts';
import type { SecretEnvelope } from '../secrets/types.ts';
import { LIVE_WORKSPACE_STATUSES } from '../workspace/types.ts';

import { FakeClock } from './fake-clock.ts';
import { createInMemoryRepositories } from './in-memory-repositories.ts';
import type { InMemoryRepositories } from './in-memory-repositories.ts';

const T0 = new Date('2026-08-19T10:00:00.000Z');

let clock: FakeClock;
let repos: InMemoryRepositories;

beforeEach(() => {
  clock = new FakeClock(T0);
  repos = createInMemoryRepositories(clock);
});

async function seedChat(title = 'Fix tests') {
  return repos.chats.create({ title, repoUrl: 'https://github.com/acme/w', baseBranch: 'main' });
}

async function seedJob(enabled = true) {
  return repos.scheduledJobs.create({
    name: 'nightly',
    cron: '0 3 * * *',
    timezone: 'UTC',
    prompt: 'lint',
    repoUrl: 'https://github.com/acme/w',
    branch: 'main',
    enabled,
  });
}

describe('createInMemoryRepositories', () => {
  /**
   * The factory wires all eight ports to one shared store; with no clock argument it uses the
   * system clock (timestamps close to now).
   */
  it('returns every repository sharing one store and defaults to the system clock', async () => {
    expect(Object.keys(repos).sort()).toEqual(
      [
        'chats',
        'jobRuns',
        'messages',
        'scheduledJobs',
        'secrets',
        'store',
        'toolCalls',
        'turns',
        'workspaces',
      ].sort(),
    );
    const defaults = createInMemoryRepositories();
    const chat = await defaults.chats.create({ title: 't', repoUrl: 'u', baseBranch: 'b' });
    expect(Math.abs(chat.createdAt.getTime() - Date.now())).toBeLessThan(5000);
    expect(defaults.store.chats.size).toBe(1);
  });
});

describe('ChatRepository', () => {
  /**
   * Create/get/list/rename/status/hints/touch: fields come from the input and clock; `list`
   * orders by `updatedAt` desc and filters by status; `ARCHIVED` stamps `archivedAt` and
   * `ACTIVE` clears it; returned objects are copies.
   */
  it('supports the full chat lifecycle', async () => {
    const a = await seedChat('A');
    expect(a).toMatchObject({ title: 'A', status: 'ACTIVE', workBranch: null, archivedAt: null });
    expect(a.createdAt).toEqual(T0);
    clock.advance(1000);
    const b = await seedChat('B');
    expect((await repos.chats.list()).map((chat) => chat.title)).toEqual(['B', 'A']);

    clock.advance(1000);
    await repos.chats.touch(a.id);
    expect((await repos.chats.list()).map((chat) => chat.title)).toEqual(['A', 'B']);

    const archived = await repos.chats.setStatus(b.id, 'ARCHIVED');
    expect(archived.archivedAt).toEqual(clock.now());
    expect((await repos.chats.list('ACTIVE')).map((chat) => chat.id)).toEqual([a.id]);
    expect((await repos.chats.list('ARCHIVED')).map((chat) => chat.id)).toEqual([b.id]);
    expect((await repos.chats.setStatus(b.id, 'ACTIVE')).archivedAt).toBeNull();

    expect((await repos.chats.rename(a.id, 'Renamed')).title).toBe('Renamed');
    const hinted = await repos.chats.updateRestoreHints(a.id, { workBranch: 'agent/x' });
    expect(hinted).toMatchObject({ workBranch: 'agent/x', lastPushedSha: null });
    const pushed = await repos.chats.updateRestoreHints(a.id, { lastPushedSha: 'abc' });
    expect(pushed).toMatchObject({ workBranch: 'agent/x', lastPushedSha: 'abc' });

    const fetched = await repos.chats.getById(a.id);
    expect(fetched?.title).toBe('Renamed');
    if (fetched) {
      fetched.title = 'mutated';
    }
    expect((await repos.chats.getById(a.id))?.title).toBe('Renamed');
    expect(await repos.chats.getById('missing')).toBeNull();
  });

  /**
   * Unknown ids raise `NotFoundError` on every mutating method.
   */
  it('throws NotFoundError for unknown chats', async () => {
    await expect(repos.chats.rename('x', 't')).rejects.toThrow(NotFoundError);
    await expect(repos.chats.touch('x')).rejects.toThrow(NotFoundError);
    await expect(repos.chats.delete('x')).rejects.toThrow(NotFoundError);
  });

  /**
   * Cascade delete: messages, turns and the turns' tool calls disappear with the chat; the
   * chat's workspace rows survive with `chatId` set to null (SetNull), other chats untouched.
   */
  it('cascades deletes to messages, turns and tool calls and nulls workspaces', async () => {
    const chat = await seedChat();
    const other = await seedChat('other');
    await repos.messages.append(chat.id, 'USER', 'hi');
    await repos.messages.append(other.id, 'USER', 'keep');
    const turn = await repos.turns.create({ chatId: chat.id, model: 'm' });
    const workspace = await repos.workspaces.create({
      kind: 'CHAT',
      chatId: chat.id,
      runnerKind: 'fake',
      image: 'img',
      repoUrl: 'u',
      branch: 'main',
    });
    await repos.toolCalls.start({
      workspaceId: workspace.id,
      turnId: turn.id,
      callId: 'c',
      seq: 0,
      toolName: 'run_shell',
      args: {},
    });
    const otherWorkspace = await repos.workspaces.create({
      kind: 'CHAT',
      chatId: other.id,
      runnerKind: 'fake',
      image: 'img',
      repoUrl: 'u',
      branch: 'main',
    });
    const job = await seedJob();
    const run = await repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: 'm',
      scheduledFor: T0,
    });
    await repos.toolCalls.start({
      workspaceId: otherWorkspace.id,
      jobRunId: run.id,
      callId: 'r',
      seq: 0,
      toolName: 'list_dir',
      args: {},
    });

    await repos.chats.delete(chat.id);
    expect((await repos.workspaces.get(otherWorkspace.id))?.chatId).toBe(other.id);
    expect(await repos.toolCalls.listByJobRun(run.id)).toHaveLength(1);
    expect(await repos.chats.getById(chat.id)).toBeNull();
    expect(await repos.messages.listByChat(chat.id)).toEqual([]);
    expect(await repos.messages.listByChat(other.id)).toHaveLength(1);
    expect(await repos.turns.get(turn.id)).toBeNull();
    expect(await repos.toolCalls.listByTurn(turn.id)).toEqual([]);
    expect((await repos.workspaces.get(workspace.id))?.chatId).toBeNull();
  });
});

describe('MessageRepository', () => {
  /**
   * Gap-free `seq`: consecutive appends number 1, 2, 3 per chat independently; `listByChat`
   * returns ascending order and supports `before` and `limit` (most recent `limit` kept).
   */
  it('assigns gap-free seq per chat and pages history', async () => {
    const chat = await seedChat();
    const other = await seedChat('other');
    const m1 = await repos.messages.append(chat.id, 'USER', 'one');
    const m2 = await repos.messages.append(chat.id, 'ASSISTANT', 'two', 'turn-1');
    const o1 = await repos.messages.append(other.id, 'USER', 'o');
    const m3 = await repos.messages.append(chat.id, 'TOOL_SUMMARY', 'three');
    expect([m1.seq, m2.seq, m3.seq]).toEqual([1, 2, 3]);
    expect(o1.seq).toBe(1);
    expect(m2.turnId).toBe('turn-1');
    expect(m1.turnId).toBeNull();

    const all = await repos.messages.listByChat(chat.id);
    expect(all.map((message) => message.content)).toEqual(['one', 'two', 'three']);
    expect((await repos.messages.listByChat(chat.id, { before: 3 })).map((m) => m.seq)).toEqual([
      1, 2,
    ]);
    expect((await repos.messages.listByChat(chat.id, { limit: 2 })).map((m) => m.seq)).toEqual([
      2, 3,
    ]);
    expect((await repos.messages.listByChat(chat.id, { limit: 5 })).map((m) => m.seq)).toEqual([
      1, 2, 3,
    ]);
    await expect(repos.messages.append('missing', 'USER', 'x')).rejects.toThrow(NotFoundError);
  });
});

describe('TurnRepository', () => {
  /**
   * Create/setStatus/finish/get/listByChat: `PREPARING` stamps `startedAt` once; status updates
   * carry workspace/queue/error fields; `finish` writes usage, terminal status and `finishedAt`.
   */
  it('tracks the turn lifecycle', async () => {
    const chat = await seedChat();
    const turn = await repos.turns.create({ chatId: chat.id, model: 'gpt', queueJobId: 'q1' });
    expect(turn).toMatchObject({
      status: 'QUEUED',
      queueJobId: 'q1',
      startedAt: null,
      stepCount: 0,
    });
    expect((await repos.turns.create({ chatId: chat.id, model: 'gpt' })).queueJobId).toBeNull();

    clock.advance(1000);
    const preparing = await repos.turns.setStatus(turn.id, 'PREPARING', { workspaceId: 'w1' });
    expect(preparing.startedAt).toEqual(clock.now());
    expect(preparing.workspaceId).toBe('w1');
    clock.advance(1000);
    const running = await repos.turns.setStatus(turn.id, 'RUNNING', {
      queueJobId: 'q2',
      error: null,
    });
    expect(running.startedAt).toEqual(preparing.startedAt);
    expect(running.queueJobId).toBe('q2');

    const finished = await repos.turns.finish(
      turn.id,
      'FAILED',
      { inputTokens: 5, outputTokens: 2, stepCount: 1 },
      'boom',
    );
    expect(finished).toMatchObject({
      status: 'FAILED',
      inputTokens: 5,
      outputTokens: 2,
      stepCount: 1,
      error: 'boom',
    });
    expect(finished.finishedAt).toEqual(clock.now());
    const succeeded = await repos.turns.finish(turn.id, 'SUCCEEDED', {
      inputTokens: 1,
      outputTokens: 1,
      stepCount: 2,
    });
    expect(succeeded.error).toBe('boom');

    expect((await repos.turns.listByChat(chat.id)).map((t) => t.id)[0]).toBe(turn.id);
    expect((await repos.turns.get(turn.id))?.status).toBe('SUCCEEDED');
    expect(await repos.turns.get('missing')).toBeNull();
    await expect(repos.turns.create({ chatId: 'missing', model: 'm' })).rejects.toThrow(
      NotFoundError,
    );
    await expect(repos.turns.setStatus('missing', 'RUNNING')).rejects.toThrow(NotFoundError);
  });
});

describe('WorkspaceRepository', () => {
  const input = {
    kind: 'CHAT' as const,
    runnerKind: 'fake',
    image: 'img',
    repoUrl: 'u',
    branch: 'main',
  };

  /**
   * One live workspace per chat: a second create for the same chat throws
   * `LiveWorkspaceExistsError` until the first one leaves the live set; job workspaces (no chat)
   * are unconstrained.
   */
  it('enforces one live workspace per chat', async () => {
    const chat = await seedChat();
    const first = await repos.workspaces.create({ ...input, chatId: chat.id });
    await expect(repos.workspaces.create({ ...input, chatId: chat.id })).rejects.toThrow(
      LiveWorkspaceExistsError,
    );
    expect((await repos.workspaces.findLiveByChat(chat.id))?.id).toBe(first.id);
    await repos.workspaces.setStatus(first.id, 'DESTROYED');
    expect(await repos.workspaces.findLiveByChat(chat.id)).toBeNull();
    const second = await repos.workspaces.create({ ...input, chatId: chat.id });
    expect(second.id).not.toBe(first.id);
    await repos.workspaces.create({ ...input, kind: 'JOB' });
    await repos.workspaces.create({ ...input, kind: 'JOB' });
    expect(await repos.workspaces.listLive()).toHaveLength(3);
  });

  /**
   * The invariant also binds UPDATEs, because Postgres enforces it with a partial unique index
   * over the live statuses rather than with an insert-time check. A FAILED row moved back into a
   * live status while a sibling of the same chat is live must be refused exactly as `create` is,
   * or the fake would report a false green for a write the database rejects.
   */
  it('refuses to move a dead workspace back into a live status beside a live sibling', async () => {
    const chat = await seedChat();
    const first = await repos.workspaces.create({ ...input, chatId: chat.id });
    await repos.workspaces.setStatus(first.id, 'FAILED', { failureReason: 'boom' });
    const second = await repos.workspaces.create({ ...input, chatId: chat.id });

    for (const status of LIVE_WORKSPACE_STATUSES) {
      await expect(repos.workspaces.setStatus(first.id, status)).rejects.toThrow(
        LiveWorkspaceExistsError,
      );
    }
    expect((await repos.workspaces.get(first.id))?.status).toBe('FAILED');
    expect((await repos.workspaces.findLiveByChat(chat.id))?.id).toBe(second.id);

    // A terminal status is always allowed, and the revival succeeds once the sibling is gone.
    await repos.workspaces.setStatus(first.id, 'DESTROYED');
    await repos.workspaces.setStatus(second.id, 'DESTROYED');
    expect((await repos.workspaces.setStatus(first.id, 'READY')).status).toBe('READY');
    expect((await repos.workspaces.findLiveByChat(chat.id))?.id).toBe(first.id);
  });

  /**
   * A live workspace may move between live statuses: the check must ignore the row being
   * updated, and a job workspace (no chat) is never constrained.
   */
  it('allows a live workspace to change status and leaves job workspaces unconstrained', async () => {
    const chat = await seedChat();
    const workspace = await repos.workspaces.create({ ...input, chatId: chat.id });
    expect((await repos.workspaces.setStatus(workspace.id, 'READY')).status).toBe('READY');
    expect((await repos.workspaces.setStatus(workspace.id, 'BUSY')).status).toBe('BUSY');

    const job = await repos.workspaces.create({ ...input, kind: 'JOB' });
    const otherJob = await repos.workspaces.create({ ...input, kind: 'JOB' });
    expect((await repos.workspaces.setStatus(job.id, 'READY')).status).toBe('READY');
    expect((await repos.workspaces.setStatus(otherJob.id, 'READY')).status).toBe('READY');
  });

  /**
   * Status changes: `READY` stamps `readyAt` once, `DESTROYED` stamps `destroyedAt`, runner ref
   * and failure reason are written when given; `markActive` bumps `lastActiveAt`; `listIdle`
   * returns READY workspaces idle before the cutoff.
   */
  it('tracks status, activity and idle candidates', async () => {
    const workspace = await repos.workspaces.create(input);
    expect(workspace).toMatchObject({
      status: 'CREATING',
      readyAt: null,
      runnerRef: null,
      chatId: null,
    });
    clock.advance(1000);
    const ready = await repos.workspaces.setStatus(workspace.id, 'READY', {
      runnerRef: 'container-1',
    });
    expect(ready.readyAt).toEqual(clock.now());
    expect(ready.runnerRef).toBe('container-1');
    clock.advance(1000);
    expect((await repos.workspaces.setStatus(workspace.id, 'READY')).readyAt).toEqual(
      ready.readyAt,
    );

    expect(await repos.workspaces.listIdle(new Date(T0.getTime() + 1))).toHaveLength(1);
    await repos.workspaces.markActive(workspace.id);
    expect(await repos.workspaces.listIdle(new Date(T0.getTime() + 1))).toHaveLength(0);
    expect((await repos.workspaces.listIdle(new Date(clock.now().getTime() + 1)))[0]?.id).toBe(
      workspace.id,
    );

    const failed = await repos.workspaces.setStatus(workspace.id, 'FAILED', {
      failureReason: 'oom',
    });
    expect(failed.failureReason).toBe('oom');
    const destroyed = await repos.workspaces.setStatus(workspace.id, 'DESTROYED');
    expect(destroyed.destroyedAt).toEqual(clock.now());
    expect(await repos.workspaces.listLive()).toEqual([]);
    expect(await repos.workspaces.get('missing')).toBeNull();
    await expect(repos.workspaces.markActive('missing')).rejects.toThrow(NotFoundError);
  });
});

describe('ScheduledJobRepository', () => {
  /**
   * CRUD + listEnabled + setRunTimes: list is newest first; update applies a partial patch and
   * bumps `updatedAt`; run times update independently; delete cascades to runs and their tool
   * calls.
   */
  it('supports CRUD, enabled listing, run times and cascade delete', async () => {
    const job = await seedJob();
    clock.advance(1000);
    const disabled = await seedJob(false);
    expect(job).toMatchObject({ enabled: true, lastRunAt: null, nextRunAt: null });
    expect((await repos.scheduledJobs.list()).map((j) => j.id)).toEqual([disabled.id, job.id]);
    expect((await repos.scheduledJobs.listEnabled()).map((j) => j.id)).toEqual([job.id]);
    expect((await repos.scheduledJobs.get(job.id))?.name).toBe('nightly');
    expect(await repos.scheduledJobs.get('missing')).toBeNull();

    clock.advance(1000);
    const updated = await repos.scheduledJobs.update(job.id, { name: 'renamed', enabled: false });
    expect(updated).toMatchObject({ name: 'renamed', enabled: false, cron: '0 3 * * *' });
    expect(updated.updatedAt).toEqual(clock.now());
    expect(await repos.scheduledJobs.listEnabled()).toEqual([]);

    const next = new Date('2026-08-20T03:00:00.000Z');
    expect((await repos.scheduledJobs.setRunTimes(job.id, { nextRunAt: next })).nextRunAt).toEqual(
      next,
    );
    const both = await repos.scheduledJobs.setRunTimes(job.id, { lastRunAt: T0, nextRunAt: null });
    expect(both).toMatchObject({ lastRunAt: T0, nextRunAt: null });
    const onlyLast = await repos.scheduledJobs.setRunTimes(job.id, { lastRunAt: next });
    expect(onlyLast).toMatchObject({ lastRunAt: next, nextRunAt: null });
    const withNext = await repos.scheduledJobs.create({
      name: 'n',
      cron: '* * * * *',
      timezone: 'UTC',
      prompt: 'p',
      repoUrl: 'u',
      branch: 'b',
      enabled: true,
      nextRunAt: next,
    });
    expect(withNext.nextRunAt).toEqual(next);

    const run = await repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: 'm',
      scheduledFor: T0,
    });
    const workspace = await repos.workspaces.create({
      kind: 'JOB',
      runnerKind: 'fake',
      image: 'i',
      repoUrl: 'u',
      branch: 'b',
    });
    await repos.toolCalls.start({
      workspaceId: workspace.id,
      jobRunId: run.id,
      callId: 'c',
      seq: 0,
      toolName: 'list_dir',
      args: {},
    });
    const chat = await seedChat();
    const turn = await repos.turns.create({ chatId: chat.id, model: 'm' });
    await repos.toolCalls.start({
      workspaceId: workspace.id,
      turnId: turn.id,
      callId: 't',
      seq: 0,
      toolName: 'read_file',
      args: {},
    });
    await repos.scheduledJobs.delete(job.id);
    expect(await repos.toolCalls.listByTurn(turn.id)).toHaveLength(1);
    expect(await repos.scheduledJobs.get(job.id)).toBeNull();
    expect(await repos.jobRuns.get(run.id)).toBeNull();
    expect(await repos.toolCalls.listByJobRun(run.id)).toEqual([]);
    await expect(repos.scheduledJobs.delete(job.id)).rejects.toThrow(NotFoundError);
    await expect(repos.scheduledJobs.update('missing', {})).rejects.toThrow(NotFoundError);
  });
});

describe('JobRunRepository', () => {
  /**
   * Lifecycle: `PREPARING` stamps `startedAt` once; `workspaceId` must be unique across runs
   * (UniqueViolationError), clearing it is allowed; `finish` writes output/error/usage;
   * `listByJob` is newest first with an optional limit; `findRunningByJob` only sees
   * PREPARING/RUNNING.
   */
  it('tracks runs with unique workspace ids and overlap lookups', async () => {
    const job = await seedJob();
    const first = await repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'm',
      scheduledFor: T0,
    });
    expect(first).toMatchObject({
      status: 'QUEUED',
      trigger: 'SCHEDULE',
      workspaceId: null,
      startedAt: null,
    });
    expect(await repos.jobRuns.findRunningByJob(job.id)).toBeNull();

    clock.advance(1000);
    const preparing = await repos.jobRuns.setStatus(first.id, 'PREPARING', { workspaceId: 'w1' });
    expect(preparing.startedAt).toEqual(clock.now());
    expect((await repos.jobRuns.findRunningByJob(job.id))?.id).toBe(first.id);
    const running = await repos.jobRuns.setStatus(first.id, 'RUNNING');
    expect(running.startedAt).toEqual(preparing.startedAt);

    clock.advance(1000);
    const second = await repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: 'm',
      scheduledFor: clock.now(),
    });
    await expect(
      repos.jobRuns.setStatus(second.id, 'PREPARING', { workspaceId: 'w1' }),
    ).rejects.toThrow(UniqueViolationError);
    await repos.jobRuns.setStatus(second.id, 'FAILED', {
      error: 'previous run still running',
      workspaceId: null,
    });
    expect((await repos.jobRuns.get(second.id))?.error).toBe('previous run still running');
    expect(
      (await repos.jobRuns.setStatus(first.id, 'RUNNING', { workspaceId: 'w1' })).workspaceId,
    ).toBe('w1');

    const finished = await repos.jobRuns.finish(first.id, {
      status: 'SUCCEEDED',
      usage: { inputTokens: 3, outputTokens: 4, stepCount: 2 },
      output: 'all good',
    });
    expect(finished).toMatchObject({
      status: 'SUCCEEDED',
      output: 'all good',
      error: null,
      inputTokens: 3,
      outputTokens: 4,
      stepCount: 2,
    });
    expect(finished.finishedAt).toEqual(clock.now());
    expect(await repos.jobRuns.findRunningByJob(job.id)).toBeNull();
    const failed = await repos.jobRuns.finish(second.id, {
      status: 'FAILED',
      usage: { inputTokens: 0, outputTokens: 0, stepCount: 0 },
      error: 'x',
    });
    expect(failed.output).toBeNull();

    expect((await repos.jobRuns.listByJob(job.id)).map((run) => run.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect((await repos.jobRuns.listByJob(job.id, { limit: 1 })).map((run) => run.id)).toEqual([
      second.id,
    ]);
    await expect(
      repos.jobRuns.create({ jobId: 'missing', trigger: 'MANUAL', model: 'm', scheduledFor: T0 }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      repos.jobRuns.finish('missing', {
        status: 'FAILED',
        usage: { inputTokens: 0, outputTokens: 0, stepCount: 0 },
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('ToolCallLogRepository', () => {
  /**
   * start/finish/list: rows start RUNNING with the clock's time, finish writes the outcome and
   * `finishedAt`, and lists are ordered by `seq` per turn and per run.
   */
  it('records tool calls per turn and per run', async () => {
    const chat = await seedChat();
    const turn = await repos.turns.create({ chatId: chat.id, model: 'm' });
    const job = await seedJob();
    const run = await repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: 'm',
      scheduledFor: T0,
    });
    const workspace = await repos.workspaces.create({
      kind: 'CHAT',
      chatId: chat.id,
      runnerKind: 'fake',
      image: 'i',
      repoUrl: 'u',
      branch: 'b',
    });

    const second = await repos.toolCalls.start({
      workspaceId: workspace.id,
      turnId: turn.id,
      callId: 'c2',
      seq: 1,
      toolName: 'read_file',
      args: { path: 'a' },
    });
    const first = await repos.toolCalls.start({
      workspaceId: workspace.id,
      turnId: turn.id,
      callId: 'c1',
      seq: 0,
      toolName: 'run_shell',
      args: { command: 'ls' },
    });
    const forRun = await repos.toolCalls.start({
      workspaceId: workspace.id,
      jobRunId: run.id,
      callId: 'c3',
      seq: 0,
      toolName: 'list_dir',
      args: {},
    });
    expect(first).toMatchObject({
      status: 'RUNNING',
      turnId: turn.id,
      jobRunId: null,
      resultHead: null,
      finishedAt: null,
    });
    expect(forRun.jobRunId).toBe(run.id);

    clock.advance(250);
    const finished = await repos.toolCalls.finish(first.id, {
      status: 'SUCCEEDED',
      exitCode: 0,
      resultHead: 'README',
      resultBytes: 6,
      durationMs: 250,
    });
    expect(finished).toMatchObject({
      status: 'SUCCEEDED',
      exitCode: 0,
      resultHead: 'README',
      resultBytes: 6,
      durationMs: 250,
    });
    expect(finished.finishedAt).toEqual(clock.now());

    expect((await repos.toolCalls.listByTurn(turn.id)).map((t) => t.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect((await repos.toolCalls.listByJobRun(run.id)).map((t) => t.id)).toEqual([forRun.id]);
    await expect(
      repos.toolCalls.finish('missing', {
        status: 'FAILED',
        exitCode: 1,
        resultHead: null,
        resultBytes: null,
        durationMs: 1,
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('SecretRepository', () => {
  const envelope: SecretEnvelope = {
    ciphertext: new Uint8Array([1, 2, 3]),
    iv: new Uint8Array(12),
    authTag: new Uint8Array(16),
    keyVersion: 1,
    last4: 'ab12',
  };

  /**
   * Append-or-replace: one row per key; upsert keeps `createdAt` and bumps `updatedAt`;
   * `status` masks every key; `remove` deletes and is a no-op when absent.
   */
  it('stores one envelope per key and reports masked status', async () => {
    expect(await repos.secrets.status()).toEqual({
      GITHUB_PAT: { set: false },
      OPENAI_API_KEY: { set: false },
    });
    await repos.secrets.upsert('GITHUB_PAT', envelope);
    const stored = await repos.secrets.get('GITHUB_PAT');
    expect(stored).toMatchObject({
      key: 'GITHUB_PAT',
      last4: 'ab12',
      keyVersion: 1,
      createdAt: T0,
      updatedAt: T0,
    });

    clock.advance(1000);
    await repos.secrets.upsert('GITHUB_PAT', { ...envelope, last4: 'cd34', keyVersion: 2 });
    const replaced = await repos.secrets.get('GITHUB_PAT');
    expect(replaced).toMatchObject({
      last4: 'cd34',
      keyVersion: 2,
      createdAt: T0,
      updatedAt: clock.now(),
    });
    expect(repos.store.secrets.size).toBe(1);

    expect(await repos.secrets.status()).toEqual({
      GITHUB_PAT: { set: true, last4: 'cd34', updatedAt: clock.now() },
      OPENAI_API_KEY: { set: false },
    });
    await repos.secrets.remove('GITHUB_PAT');
    await repos.secrets.remove('GITHUB_PAT');
    expect(await repos.secrets.get('GITHUB_PAT')).toBeNull();
  });
});
