/**
 * End-to-end tests of the worker against real Docker, Postgres and Redis.
 *
 * Layer: integration (`@docker @db @redis`).
 * Goal: prove the flows the unit suite can only simulate — a turn that really clones a repository
 * and runs the bundled runtime in a container, a workspace in which no shell command can find the
 * credentials that turn ran with, the collector reclaiming an idle workspace and an orphan
 * container, a restored turn cloning into a brand-new workspace, a scheduled run whose container
 * is destroyed when it finishes, and a deleted chat leaving neither a container nor a row that
 * claims to have one. The model is the only fake.
 * Mocks: `AGENT_MODEL_PROVIDER=fake` inside the container; everything else is production wiring.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  destroyChatWorkspacePayload,
  JOB_NAMES,
  WORKER_HEARTBEAT_TTL_SEC,
  workerHeartbeatKey,
  workerHeartbeatSchema,
} from '@agent-hangar/core';
import type { Chat, WorkspaceHandle } from '@agent-hangar/core';
import { assertNoCanary, CANARY_MARKER } from '@agent-hangar/core/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { CREDENTIALS_PATH, LABELS, WORKSPACE_LIMITS } from '../processors/constants.js';

import { describeDocker } from './describe-docker.js';
import {
  createIntegrationHarness,
  TEST_REPO_BRANCH,
  TEST_REPO_URL,
} from './harness.integration-helper.js';
import type { IntegrationHarness, StreamEntry } from './harness.integration-helper.js';

/** Prompt the bundled fake provider answers with a directory listing and a file write. */
const CREATE_PROMPT = 'list files and create NOTES.md';

/** Prompt it answers by reading that file back. */
const READ_PROMPT = 'show NOTES.md';

/** How long a row is polled for after its container is already gone. */
const ROW_SETTLE_MS = 10_000;

describeDocker('worker end-to-end', () => {
  let harness: IntegrationHarness;
  let keyDirectory: string;
  let chat: Chat;

  beforeAll(async () => {
    keyDirectory = await mkdtemp(join(tmpdir(), 'ah-w2b-'));
    harness = await createIntegrationHarness({
      masterKeyPath: join(keyDirectory, 'master.key'),
    });
    chat = await harness.container.repos.chats.create({
      title: 'Integration',
      repoUrl: TEST_REPO_URL,
      baseBranch: TEST_REPO_BRANCH,
    });
  });

  afterAll(async () => {
    await harness.close();
    await rm(keyDirectory, { recursive: true, force: true });
  });

  /**
   * Enqueues a turn for the shared chat and waits for it to finish.
   *
   * @param prompt - The user message.
   * @returns The turn id and the entries its stream carries.
   */
  async function runTurn(prompt: string): Promise<{ turnId: string; stream: StreamEntry[] }> {
    const { repos, queues } = harness.container;
    await repos.messages.append(chat.id, 'USER', prompt);
    const turn = await repos.turns.create({ chatId: chat.id, model: harness.config.OPENAI_MODEL });
    await queues.chatTurns.add(JOB_NAMES.runTurn, { turnId: turn.id }, { jobId: turn.id });

    // The turn is finished the moment the runtime reports it, but its workspace goes back to
    // `READY` a step later, in the processor's own bookkeeping. Waiting for both is what makes the
    // assertions below about a settled turn rather than about a race.
    await harness.waitFor(`turn ${turn.id} to settle`, async () => {
      const current = await repos.turns.get(turn.id);
      if (current?.finishedAt == null) {
        return false;
      }
      const workspace = await repos.workspaces.findLiveByChat(chat.id);
      return workspace?.status !== 'BUSY';
    });
    const stream = await harness.readStream(turn.id);
    const finished = await repos.turns.get(turn.id);
    if (finished?.status !== 'SUCCEEDED') {
      // Printed so a failing run is diagnosable from the CI log alone.
      console.error(
        'turn did not succeed',
        finished?.error,
        stream.map((entry) => entry.event.type),
      );
    }
    return { turnId: turn.id, stream };
  }

  /**
   * Runs one command inside a live workspace and returns everything it wrote.
   *
   * @param handle - The workspace to run in.
   * @param cmd - Argument vector.
   * @returns Standard output and standard error, concatenated in arrival order.
   */
  async function execInWorkspace(handle: WorkspaceHandle, cmd: readonly string[]): Promise<string> {
    const decoder = new TextDecoder();
    let output = '';
    for await (const event of harness.container.runner.exec(handle, { cmd })) {
      if (event.type === 'stdout' || event.type === 'stderr') {
        output += decoder.decode(event.data);
      }
    }
    return output;
  }

  /**
   * A first message really creates a container, clones the repository, runs the bundled runtime
   * and turns everything it emits into stream entries and rows.
   */
  it('runs a turn in a real container and records everything it produced', async () => {
    const { repos } = harness.container;

    const { turnId, stream } = await runTurn(CREATE_PROMPT);

    const turn = await repos.turns.get(turnId);
    expect(turn?.status).toBe('SUCCEEDED');
    expect(turn?.stepCount).toBeGreaterThan(0);

    const workspace = await repos.workspaces.findLiveByChat(chat.id);
    expect(workspace?.status).toBe('READY');
    expect(workspace?.runnerRef).not.toBeNull();

    const handles = await harness.listInstanceHandles();
    expect(handles).toHaveLength(1);
    expect(handles[0]?.workspaceId).toBe(workspace?.id);

    const types = stream.map((entry) => entry.event.type);
    expect(types).toContain('turn.started');
    expect(types).toContain('prepare.done');
    expect(types).toContain('tool.call');
    expect(types.at(-1)).toBe('turn.completed');
    expect(types.indexOf('turn.started')).toBeLessThan(types.indexOf('prepare.done'));
    expect(await harness.streamTtl(turnId)).toBeGreaterThan(0);

    const toolCalls = await repos.toolCalls.listByTurn(turnId);
    expect(toolCalls.length).toBeGreaterThan(0);

    const messages = await repos.messages.listByChat(chat.id);
    expect(messages.map((message) => message.role)).toContain('TOOL_SUMMARY');
    expect(messages.at(-1)?.role).toBe('ASSISTANT');

    const persisted = JSON.stringify([messages, toolCalls, turn, workspace]);
    expect(() => {
      assertNoCanary(persisted);
    }).not.toThrow();
    expect(() => {
      assertNoCanary(JSON.stringify(stream));
    }).not.toThrow();
  });

  /**
   * What a `run_shell` command can find once a turn has run in the workspace it will run in again.
   *
   * This is the finding, measured where it lives. Every process of a workspace runs as the same
   * unprivileged user, so `/proc/<pid>/environ` is an ordinary readable file to the agent and PID 1
   * lives as long as the container — a credential put in the container's environment is one the
   * model can read back at any point of any later turn. The credentials of a turn are placed as a
   * file for that one execution instead, and the runtime unlinks them as it starts, so the search
   * below runs after a real turn has completed and comes back with nothing.
   *
   * The canary marker is searched for as well as the canaries themselves: a partial or re-encoded
   * credential is still a leak, and matching only the exact values would miss it.
   */
  it('leaves no credential a later shell command in the same workspace could read', async () => {
    const workspace = await harness.container.repos.workspaces.findLiveByChat(chat.id);
    const handle: WorkspaceHandle = {
      workspaceId: workspace?.id ?? '',
      runnerRef: workspace?.runnerRef ?? '',
    };

    const environ = await execInWorkspace(handle, [
      'sh',
      '-c',
      'cat /proc/1/environ | tr "\\0" "\\n"',
    ]);
    const handoff = await execInWorkspace(handle, ['ls', '-A', '/opt/agent-runtime/handoff']);
    const sweep = await execInWorkspace(handle, [
      'sh',
      '-c',
      `grep -rl ${CANARY_MARKER} /proc/1/environ /proc/self/environ /opt/agent-runtime 2>/dev/null; echo "swept"`,
    ]);

    // The reads themselves worked, so what follows is an absence rather than a failed command.
    expect(environ).toContain('AGENT_MODEL_PROVIDER=');
    expect(sweep).toContain('swept');
    expect(() => {
      assertNoCanary(environ);
    }).not.toThrow();
    expect(environ).not.toContain(CANARY_MARKER);
    expect(handoff.trim()).toBe('');
    expect(sweep).not.toContain(CREDENTIALS_PATH);
    expect(sweep.replace('swept', '').trim()).toBe('');
  });

  /**
   * The health card reads Docker reachability, image presence and the container count from this
   * key and from nothing else, so the worker has to have published it by the time it is ready.
   */
  it('publishes a health heartbeat the web app can read', async () => {
    const raw = await harness.inspect.get(workerHeartbeatKey(harness.config.AH_INSTANCE));
    const ttl = await harness.inspect.ttl(workerHeartbeatKey(harness.config.AH_INSTANCE));

    expect(raw).not.toBeNull();
    expect(workerHeartbeatSchema.parse(JSON.parse(raw ?? 'null'))).toMatchObject({
      dockerOk: true,
      imagePresent: true,
    });
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(WORKER_HEARTBEAT_TTL_SEC);
  });

  /**
   * An idle workspace is reclaimed, its chat is told, and the container is really gone — and an
   * orphan container this instance owns goes with it.
   */
  it('reclaims an idle workspace and an orphan container', async () => {
    const { repos, prisma } = harness.container;
    const workspace = await repos.workspaces.findLiveByChat(chat.id);
    const workspaceId = workspace?.id ?? '';
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { lastActiveAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });
    const orphanId = `orphan-${Date.now().toString(36)}`;
    await harness.container.runner.create({
      workspaceId: orphanId,
      kind: 'CHAT',
      image: harness.config.WORKSPACE_IMAGE,
      env: {},
      limits: { cpus: 1, memoryBytes: 512 * 1024 * 1024, pids: 64 },
      labels: {
        [LABELS.instance]: harness.config.AH_INSTANCE,
        [LABELS.workspace]: orphanId,
        [LABELS.kind]: 'CHAT',
      },
    });

    await harness.container.queues.workspaceGc.add(JOB_NAMES.reapIdle, {});
    await harness.waitFor('the collector to run', async () => {
      const current = await repos.workspaces.get(workspaceId);
      return current?.status === 'DESTROYED';
    });

    expect(await repos.workspaces.findLiveByChat(chat.id)).toBeNull();
    await expect(
      harness.container.runner.health({ workspaceId, runnerRef: workspace?.runnerRef ?? '' }),
    ).resolves.toEqual({ status: 'gone' });
    const messages = await repos.messages.listByChat(chat.id);
    expect(messages.at(-1)?.content).toContain('Workspace reclaimed');

    await harness.waitFor('the orphan to be destroyed', async () => {
      const handles = await harness.listInstanceHandles();
      return !handles.some((handle) => handle.workspaceId === orphanId);
    });
  });

  /**
   * The next message rebuilds the workspace from history: a new container, a fresh clone, and a
   * transcript that still carries everything the first turn wrote.
   */
  it('restores the chat into a new workspace on the next message', async () => {
    const { repos } = harness.container;
    const before = (await repos.messages.listByChat(chat.id)).length;

    const { turnId, stream } = await runTurn(READ_PROMPT);

    expect((await repos.turns.get(turnId))?.status).toBe('SUCCEEDED');
    const types = stream.map((entry) => entry.event.type);
    expect(types).toContain('prepare.progress');
    expect(types).toContain('prepare.done');

    const workspace = await repos.workspaces.findLiveByChat(chat.id);
    expect(workspace?.status).toBe('READY');
    expect((await repos.messages.listByChat(chat.id)).length).toBeGreaterThan(before);
  });

  /**
   * A scheduled run gets a container of its own, records its answer as the run's output, and the
   * container is destroyed before the processor returns.
   */
  it('runs a scheduled job in a fresh workspace and destroys it', async () => {
    const { repos, queues } = harness.container;
    const job = await repos.scheduledJobs.create({
      name: 'print the date',
      cron: '*/5 * * * *',
      timezone: 'UTC',
      prompt: 'print date',
      repoUrl: TEST_REPO_URL,
      branch: TEST_REPO_BRANCH,
      enabled: true,
    });

    await queues.scheduledJobs.add(JOB_NAMES.runScheduledJob, {
      jobId: job.id,
      trigger: 'MANUAL',
    });
    // The run is finished as soon as the runtime reports it, but its container is destroyed in the
    // processor's `finally` a moment later; waiting for the row proves the guarantee and keeps the
    // next scenario from counting a container that is on its way out.
    await harness.waitFor('the scheduled run to finish and release its workspace', async () => {
      const [latest] = await repos.jobRuns.listByJob(job.id);
      if (latest?.finishedAt === null || latest?.workspaceId == null) {
        return false;
      }
      const used = await repos.workspaces.get(latest.workspaceId);
      return used?.status === 'DESTROYED';
    });

    const [run] = await repos.jobRuns.listByJob(job.id);
    expect(run?.status).toBe('SUCCEEDED');
    expect(run?.output).toBeTruthy();
    expect(run?.trigger).toBe('MANUAL');

    const workspace = await repos.workspaces.get(run?.workspaceId ?? '');
    expect(workspace?.kind).toBe('JOB');
    expect(workspace?.status).toBe('DESTROYED');
    const handles = await harness.container.runner.list({
      [LABELS.instance]: harness.config.AH_INSTANCE,
      [LABELS.jobRun]: run?.id ?? '',
    });
    expect(handles).toHaveLength(0);

    expect((await repos.scheduledJobs.get(job.id))?.nextRunAt).not.toBeNull();
  });

  /**
   * A tick that fires while the previous run is still executing is recorded as a failure rather
   * than queued, so a slow job cannot accumulate containers.
   */
  it('records an overlapping tick without starting a container', async () => {
    const { repos } = harness.container;
    const job = await repos.scheduledJobs.create({
      name: 'overlapping',
      cron: '*/5 * * * *',
      timezone: 'UTC',
      prompt: 'print date',
      repoUrl: TEST_REPO_URL,
      branch: TEST_REPO_BRANCH,
      enabled: true,
    });
    const running = await repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: harness.config.OPENAI_MODEL,
      scheduledFor: new Date(),
    });
    await repos.jobRuns.setStatus(running.id, 'PREPARING');
    const before = (await repos.workspaces.listLive()).length;

    const { createRunScheduledJobProcessor } = await import('../processors/run-scheduled-job.js');
    await createRunScheduledJobProcessor(harness.container)({
      id: 'manual',
      name: JOB_NAMES.runScheduledJob,
      data: { jobId: job.id, trigger: 'MANUAL' },
    });

    const runs = await repos.jobRuns.listByJob(job.id);
    const skipped = runs.find((entry) => entry.id !== running.id);
    expect(skipped).toMatchObject({
      status: 'FAILED',
      error: 'overlapping_run: previous run still running',
    });
    expect(await repos.workspaces.listLive()).toHaveLength(before);
    expect(skipped?.workspaceId).toBeNull();

    await repos.jobRuns.finish(running.id, {
      status: 'CANCELLED',
      usage: { inputTokens: 0, outputTokens: 0, stepCount: 0 },
    });
  });

  /**
   * Deleting a chat must leave nothing claiming to be live. The chat's cascade sets
   * `Workspace.chatId` to null — the column is `SetNull` — so by the time the teardown job runs,
   * the chat can no longer name the row: the job has to carry the workspace's own id, and the
   * consumer has to use it. Measured on a real database before this was so: the container was
   * removed by the consumer's label sweep, which writes no row, and the workspace stayed `READY`
   * pointing at a container that no longer existed.
   *
   * Everything here is production wiring — the real repositories against Postgres, the real
   * producer, the real queue and the real consumer — because the defect lives precisely in what
   * the database does to the row between two of those steps.
   */
  it('leaves no live row behind when a chat with a workspace is deleted', async () => {
    const { repos, queues, runner } = harness.container;
    const deleted = await repos.chats.create({
      title: 'Deleted while it had a workspace',
      repoUrl: TEST_REPO_URL,
      baseBranch: TEST_REPO_BRANCH,
    });
    const workspace = await repos.workspaces.create({
      kind: 'CHAT',
      chatId: deleted.id,
      runnerKind: runner.kind,
      image: harness.config.WORKSPACE_IMAGE,
      repoUrl: TEST_REPO_URL,
      branch: TEST_REPO_BRANCH,
    });
    const handle = await runner.create({
      workspaceId: workspace.id,
      kind: 'CHAT',
      image: harness.config.WORKSPACE_IMAGE,
      env: {},
      limits: WORKSPACE_LIMITS,
      labels: {
        [LABELS.instance]: harness.config.AH_INSTANCE,
        [LABELS.workspace]: workspace.id,
        [LABELS.kind]: 'CHAT',
        [LABELS.chat]: deleted.id,
      },
    });
    await repos.workspaces.setStatus(workspace.id, 'READY', { runnerRef: handle.runnerRef });

    // Exactly what the delete handler does, in the order it does it: read the live workspace,
    // delete the chat, then enqueue the teardown for the workspace it read.
    const live = await repos.workspaces.findLiveByChat(deleted.id);
    expect(await repos.chats.deleteIfIdle(deleted.id)).toBe('DELETED');
    expect((await repos.workspaces.get(workspace.id))?.chatId).toBeNull();
    await queues.workspaceGc.add(
      JOB_NAMES.destroyChatWorkspace,
      destroyChatWorkspacePayload.parse({ chatId: deleted.id, workspaceId: live?.id }),
      { jobId: `destroy-${deleted.id}` },
    );

    await harness.waitFor("the deleted chat's container to be removed", async () => {
      const handles = await runner.list({
        [LABELS.instance]: harness.config.AH_INSTANCE,
        [LABELS.workspace]: workspace.id,
      });
      return handles.length === 0;
    });

    await expect
      .poll(async () => (await repos.workspaces.get(workspace.id))?.status, {
        timeout: ROW_SETTLE_MS,
      })
      .toBe('DESTROYED');
    expect((await repos.workspaces.get(workspace.id))?.destroyedAt).not.toBeNull();
    expect((await repos.workspaces.listLive()).map((row) => row.id)).not.toContain(workspace.id);
  });

  /**
   * A teardown that reached `STOPPING` and then lost its process leaves a live row pointing at a
   * container that is still running, and no other pass can take it: a teardown refuses anything
   * that is not `READY`, the idle selection refuses it for the same reason, and the reconciliation
   * refuses it because the container is right there and so is not missing. Until this was
   * measurable the only thing that reclaimed it was the next worker boot, which does not help a
   * process that is still up.
   *
   * The row is left in exactly the state that failure produces — `STOPPING`, with a real container
   * behind its reference — and the assertion is the container's own absence from the daemon, not a
   * status somebody wrote about it.
   */
  it('finishes a teardown whose process never came back for the container', async () => {
    const { repos, queues, runner } = harness.container;
    const workspace = await repos.workspaces.create({
      kind: 'JOB',
      runnerKind: runner.kind,
      image: harness.config.WORKSPACE_IMAGE,
      repoUrl: TEST_REPO_URL,
      branch: TEST_REPO_BRANCH,
    });
    const handle = await runner.create({
      workspaceId: workspace.id,
      kind: 'JOB',
      image: harness.config.WORKSPACE_IMAGE,
      env: {},
      limits: WORKSPACE_LIMITS,
      labels: {
        [LABELS.instance]: harness.config.AH_INSTANCE,
        [LABELS.workspace]: workspace.id,
        [LABELS.kind]: 'JOB',
      },
    });
    await repos.workspaces.setStatus(workspace.id, 'READY', { runnerRef: handle.runnerRef });
    expect(await repos.workspaces.claimStatus(workspace.id, 'READY', 'STOPPING')).not.toBeNull();
    await expect(runner.health(handle)).resolves.toMatchObject({ status: 'healthy' });

    await queues.workspaceGc.add(JOB_NAMES.reapIdle, {});

    await harness.waitFor('the abandoned container to be removed', async () => {
      const handles = await runner.list({
        [LABELS.instance]: harness.config.AH_INSTANCE,
        [LABELS.workspace]: workspace.id,
      });
      return handles.length === 0;
    });

    await expect
      .poll(async () => (await repos.workspaces.get(workspace.id))?.status, {
        timeout: ROW_SETTLE_MS,
      })
      .toBe('DESTROYED');
    expect((await repos.workspaces.listLive()).map((row) => row.id)).not.toContain(workspace.id);
  });
});
