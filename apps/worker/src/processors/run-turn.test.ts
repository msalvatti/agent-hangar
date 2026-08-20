/**
 * Unit tests for the `run-turn` processor.
 *
 * Layer: unit.
 * Goal: the whole flow of spec 04 (a) and (b) against in-memory collaborators — workspace ensure,
 * reuse, stalled recovery, the request the runtime receives, every event's rows, every failure
 * path, cancellation, and the guarantee that a credential reaches neither a row nor an event.
 * Mocks: `createTestContainer` (in-memory repositories, fake runner, real redactor) plus small
 * runner subclasses for the failures the fake runner cannot produce on its own.
 */
import {
  DEFAULT_CHAT_TURN_LIMITS,
  LiveWorkspaceExistsError,
  turnRequestSchema,
  WorkspaceImageMissing,
} from '@agent-hangar/core';
import type {
  AgentEvent,
  Chat,
  ExecEvent,
  ExecSpec,
  Repositories,
  RunTurnPayload,
  Turn,
  Workspace,
  WorkspaceHandle,
  WorkspaceHealth,
  WorkspaceRepository,
  WorkspaceSpec,
} from '@agent-hangar/core';
import {
  assertNoCanary,
  FakeClock,
  FakeWorkspaceRunner,
  GITHUB_CANARY,
  OPENAI_CANARY,
} from '@agent-hangar/core/testing';
import type { ExecScript, FakeWorkspaceRunnerOptions } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  createTestContainer,
  FakeSecretsService,
  scriptedRuntime,
  stdinOf,
} from '../testing/index.js';
import type { TestContainer } from '../testing/index.js';

import { STALLED_RECOVERY_NOTE, STALLED_RECOVERY_REASON } from './constants.js';
import { createRunTurnProcessor, WORKSPACE_CONFLICT_CODE } from './run-turn.js';
import type { ProcessorJob } from './types.js';

const REPO_URL = 'https://github.com/octocat/Hello-World.git';
const NOTES_CONTENT = '# Notes\n';

/** A clock that moves on every read, so `lastActiveAt` can be told apart from `createdAt`. */
class TickingClock extends FakeClock {
  override now(): Date {
    const instant = super.now();
    this.advance(1000);
    return instant;
  }
}

/** A runner whose containers are always reported as gone. */
class GoneRunner extends FakeWorkspaceRunner {
  override health(): Promise<WorkspaceHealth> {
    return Promise.resolve({ status: 'gone' });
  }
}

/** A runner whose containers are alive but broken. */
class UnhealthyRunner extends FakeWorkspaceRunner {
  override health(): Promise<WorkspaceHealth> {
    return Promise.resolve({ status: 'unhealthy', reason: 'exec probe failed' });
  }
}

/** A runner that has no workspace image. */
class ImagelessRunner extends FakeWorkspaceRunner {
  override create(): Promise<WorkspaceHandle> {
    return Promise.reject(new WorkspaceImageMissing('agent-hangar/workspace:test'));
  }
}

/** A runner whose `exec` cannot be started at all. */
class UnreachableRunner extends FakeWorkspaceRunner {
  constructor(
    private readonly failure: unknown,
    options: FakeWorkspaceRunnerOptions = {},
  ) {
    super(options);
  }

  override async *exec(): AsyncIterable<ExecEvent> {
    await Promise.resolve();
    throw this.failure;
  }
}

/** A runner whose `create` cannot reach the daemon. */
class UncreatableRunner extends FakeWorkspaceRunner {
  constructor(
    private readonly failure: unknown,
    options: FakeWorkspaceRunnerOptions = {},
  ) {
    super(options);
  }

  override async create(): Promise<WorkspaceHandle> {
    await Promise.resolve();
    throw this.failure;
  }
}

/** Builds the socket error a Docker daemon that is not listening produces. */
function connectionRefused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), {
    code: 'ECONNREFUSED',
  });
}

/** The events a successful turn produces, in the order the runtime writes them. */
function happyScript(): AgentEvent[] {
  return [
    { type: 'turn.started', turnId: 'ignored', at: '2026-01-01T00:00:00.000Z' },
    { type: 'prepare.progress', message: 'Cloning…' },
    { type: 'prepare.done', headSha: 'abc1234', branch: 'main' },
    { type: 'step.started', step: 1 },
    { type: 'assistant.delta', text: 'Writing' },
    {
      type: 'tool.call',
      callId: 'call-1',
      name: 'write_file',
      args: { path: 'NOTES.md', content: NOTES_CONTENT },
      seq: 1,
    },
    { type: 'tool.output.delta', callId: 'call-1', stream: 'stdout', text: 'wrote ' },
    { type: 'tool.output.delta', callId: 'call-1', stream: 'stdout', text: 'NOTES.md' },
    {
      type: 'tool.result',
      callId: 'call-1',
      exitCode: 0,
      bytes: 14,
      durationMs: 12,
      status: 'SUCCEEDED',
    },
    { type: 'git.pushed', branch: 'agent/feature', sha: 'deadbee' },
    { type: 'step.started', step: 2 },
    { type: 'assistant.message', text: 'Created NOTES.md.' },
    {
      type: 'turn.completed',
      usage: { inputTokens: 11, outputTokens: 22 },
      steps: 2,
      finalMessage: 'Created NOTES.md.',
    },
  ];
}

/** How a test wants its container wired. */
interface SetupOptions {
  script?: ExecScript;
  clock?: FakeClock;
  secrets?: FakeSecretsService;
  /** Built with the clock and script the setup resolved. */
  runner?: (options: FakeWorkspaceRunnerOptions) => FakeWorkspaceRunner;
}

/** Builds a test container whose runner already carries the script the test needs. */
function setup(options: SetupOptions = {}): TestContainer {
  const clock = options.clock ?? new FakeClock();
  const runnerOptions: FakeWorkspaceRunnerOptions = {
    clock,
    scripts: options.script === undefined ? [] : [options.script],
  };
  const runner = (options.runner ?? ((opts) => new FakeWorkspaceRunner(opts)))(runnerOptions);
  return createTestContainer({
    clock,
    runner,
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
  });
}

/** Seeds a chat with its opening user message and a queued turn. */
async function seed(
  container: TestContainer,
  options: { repoUrl?: string } = {},
): Promise<{ chat: Chat; turn: Turn }> {
  const chat = await container.repos.chats.create({
    title: 'First task',
    repoUrl: options.repoUrl ?? REPO_URL,
    baseBranch: 'main',
  });
  await container.repos.messages.append(chat.id, 'USER', 'list files and create NOTES.md');
  const turn = await container.repos.turns.create({
    chatId: chat.id,
    model: container.config.OPENAI_MODEL,
  });
  return { chat, turn };
}

/** Builds the structural part of a BullMQ job the processor reads. */
function job(turnId: string, attemptsMade = 0): ProcessorJob<RunTurnPayload> {
  return { id: turnId, name: 'run-turn', data: { turnId }, attemptsMade };
}

/** Runs the processor over a seeded turn. */
async function run(container: TestContainer, turnId: string, attemptsMade = 0): Promise<void> {
  await createRunTurnProcessor(container)(job(turnId, attemptsMade));
}

/** The workspace spec of the last `create` the runner recorded. */
function lastCreateSpec(container: TestContainer): WorkspaceSpec {
  const call = container.runner.calls.findLast((entry) => entry.method === 'create');
  return call?.args[0] as WorkspaceSpec;
}

/** The turn request the runtime was handed, read back from the recorded exec. */
async function requestSentTo(container: TestContainer): Promise<unknown> {
  const call = container.runner.calls.findLast((entry) => entry.method === 'exec');
  return turnRequestSchema.parse(JSON.parse(await stdinOf(call?.args[1] as ExecSpec)));
}

/** Every string this run persisted, for a leak assertion. */
function persistedText(container: TestContainer): string {
  const { store } = container.repos;
  return JSON.stringify([
    [...store.chats.values()],
    [...store.messages.values()],
    [...store.turns.values()],
    [...store.workspaces.values()],
    [...store.toolCalls.values()],
  ]);
}

describe('createRunTurnProcessor', () => {
  /**
   * A first message: no workspace exists, so one is created with the credentials and the labels
   * the collector selects on, the runtime is handed a cloning request built from the chat, and
   * every event it emits becomes a stream entry and a row.
   */
  it('runs a first turn end to end', async () => {
    const container = setup({ script: scriptedRuntime(happyScript()), clock: new TickingClock() });
    const { chat, turn } = await seed(container);

    await run(container, turn.id);

    const spec = lastCreateSpec(container);
    expect(spec.kind).toBe('CHAT');
    expect(spec.env).toMatchObject({
      GITHUB_TOKEN: GITHUB_CANARY,
      OPENAI_API_KEY: OPENAI_CANARY,
      GIT_ASKPASS: '/opt/agent-runtime/askpass.sh',
      AGENT_MODEL_PROVIDER: 'fake',
      OPENAI_MODEL: 'test-model',
    });
    expect(spec.labels).toEqual({
      'ah.instance': 'w2b-unit',
      'ah.workspace': spec.workspaceId,
      'ah.kind': 'CHAT',
      'ah.chat': chat.id,
    });

    const request = (await requestSentTo(container)) as {
      prepare: { clone: boolean };
      repo: { workBranch: string; url: string };
      items: { content?: string }[];
      limits: unknown;
    };
    expect(request.prepare.clone).toBe(true);
    expect(request.repo.workBranch).toBe(`agent/${chat.id.slice(0, 8)}`);
    expect(request.repo.url).toBe(REPO_URL);
    expect(request.items.at(0)?.content).toBe('list files and create NOTES.md');
    expect(request.limits).toEqual(DEFAULT_CHAT_TURN_LIMITS);

    expect(container.publisher.eventsFor(turn.id)).toEqual(happyScript());

    const logs = await container.repos.toolCalls.listByTurn(turn.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      callId: 'call-1',
      toolName: 'write_file',
      status: 'SUCCEEDED',
      resultHead: 'wrote NOTES.md',
      resultBytes: 14,
      jobRunId: null,
    });

    const messages = await container.repos.messages.listByChat(chat.id);
    expect(messages.map((message) => message.role)).toEqual(['USER', 'TOOL_SUMMARY', 'ASSISTANT']);
    expect(messages[1]?.content).toBe(`wrote NOTES.md (${Buffer.byteLength(NOTES_CONTENT)} bytes)`);
    expect(messages[2]?.content).toBe('Created NOTES.md.');
    expect(messages[2]?.turnId).toBe(turn.id);

    const finished = await container.repos.turns.get(turn.id);
    expect(finished).toMatchObject({
      status: 'SUCCEEDED',
      inputTokens: 11,
      outputTokens: 22,
      stepCount: 2,
    });
    expect(finished?.startedAt).not.toBeNull();
    expect(finished?.finishedAt).not.toBeNull();

    const live = await container.repos.workspaces.findLiveByChat(chat.id);
    expect(live?.status).toBe('READY');
    expect(live?.lastActiveAt.getTime()).toBeGreaterThan(live?.createdAt.getTime() ?? 0);

    expect(await container.repos.chats.getById(chat.id)).toMatchObject({
      workBranch: 'agent/feature',
      lastPushedSha: 'deadbee',
    });
  });

  /**
   * A second message reuses the container that is still running, so nothing is cloned and no new
   * workspace row appears.
   */
  it('reuses a live workspace and does not clone again', async () => {
    const container = setup({ script: scriptedRuntime(happyScript()) });
    const { chat, turn } = await seed(container);
    await run(container, turn.id);
    const first = (await container.repos.workspaces.findLiveByChat(chat.id))?.id;

    const second = await container.repos.turns.create({ chatId: chat.id, model: 'test-model' });
    container.runner.calls.length = 0;
    await run(container, second.id);

    expect(container.runner.calls.some((call) => call.method === 'create')).toBe(false);
    const request = (await requestSentTo(container)) as { prepare: { clone: boolean } };
    expect(request.prepare.clone).toBe(false);
    expect((await container.repos.workspaces.findLiveByChat(chat.id))?.id).toBe(first);
    expect((await container.repos.turns.get(second.id))?.workspaceId).toBe(first);
  });

  /**
   * A container that vanished (Docker restarted, the user removed it) closes its row out and the
   * turn continues in a fresh workspace, cloning from history.
   */
  it('replaces a workspace whose container is gone', async () => {
    const container = setup({
      script: scriptedRuntime(happyScript()),
      runner: (options) => new GoneRunner(options),
    });
    const { chat, turn } = await seed(container);
    await run(container, turn.id);
    const second = await container.repos.turns.create({ chatId: chat.id, model: 'test-model' });

    await run(container, second.id);

    const rows = [...container.repos.store.workspaces.values()];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe('DESTROYED');
    const request = (await requestSentTo(container)) as { prepare: { clone: boolean } };
    expect(request.prepare.clone).toBe(true);
  });

  /**
   * A container that answers but is broken is recorded as failed with the runner's reason, and the
   * turn gets a new one.
   */
  it('replaces an unhealthy workspace', async () => {
    const container = setup({
      script: scriptedRuntime(happyScript()),
      runner: (options) => new UnhealthyRunner(options),
    });
    const { chat, turn } = await seed(container);
    await run(container, turn.id);
    const second = await container.repos.turns.create({ chatId: chat.id, model: 'test-model' });

    await run(container, second.id);

    const rows = [...container.repos.store.workspaces.values()];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'FAILED', failureReason: 'exec probe failed' });
  });

  /**
   * A workspace found `BUSY` belonged to a worker that died mid-turn: it is destroyed, the model
   * is told its filesystem is gone, and the turn runs in a fresh one.
   */
  it('recovers from a stalled previous attempt', async () => {
    const container = setup({ script: scriptedRuntime(happyScript()) });
    const { chat, turn } = await seed(container);
    const stalled = await container.repos.workspaces.create({
      kind: 'CHAT',
      chatId: chat.id,
      runnerKind: 'fake',
      image: 'image',
      repoUrl: REPO_URL,
      branch: 'main',
    });
    await container.repos.workspaces.setStatus(stalled.id, 'READY', { runnerRef: 'ref-1' });
    await container.repos.workspaces.setStatus(stalled.id, 'BUSY');

    await run(container, turn.id);

    expect(container.runner.calls.some((call) => call.method === 'destroy')).toBe(true);
    expect(await container.repos.workspaces.get(stalled.id)).toMatchObject({
      status: 'DESTROYED',
      failureReason: STALLED_RECOVERY_REASON,
    });
    const messages = await container.repos.messages.listByChat(chat.id);
    expect(messages.map((message) => message.content)).toContain(STALLED_RECOVERY_NOTE);
    expect((await container.repos.turns.get(turn.id))?.status).toBe('SUCCEEDED');
  });

  /**
   * A workspace still being created when its owner died has no runner reference yet; the recovery
   * must still close the row out rather than skip it.
   */
  it('recovers a workspace whose container was never reported', async () => {
    const container = setup({ script: scriptedRuntime(happyScript()) });
    const { chat, turn } = await seed(container);
    const creating = await container.repos.workspaces.create({
      kind: 'CHAT',
      chatId: chat.id,
      runnerKind: 'fake',
      image: 'image',
      repoUrl: REPO_URL,
      branch: 'main',
    });

    await run(container, turn.id);

    expect(await container.repos.workspaces.get(creating.id)).toMatchObject({
      status: 'DESTROYED',
      runnerRef: null,
    });
    expect((await container.repos.turns.get(turn.id))?.status).toBe('SUCCEEDED');
  });

  /**
   * A retried delivery cannot trust the workspace either, even when it looks ready: the attempt
   * that left it behind is no longer reading its exec. A runner that refuses to destroy it must
   * not stop the recovery.
   */
  it('recovers on a retry and survives a failed destroy', async () => {
    const container = setup({ script: scriptedRuntime(happyScript()) });
    const { chat, turn } = await seed(container);
    const stale = await container.repos.workspaces.create({
      kind: 'CHAT',
      chatId: chat.id,
      runnerKind: 'fake',
      image: 'image',
      repoUrl: REPO_URL,
      branch: 'main',
    });
    await container.repos.workspaces.setStatus(stale.id, 'READY', { runnerRef: 'ref-1' });
    vi.spyOn(container.runner, 'destroy').mockRejectedValueOnce(new Error('daemon busy'));

    await run(container, turn.id, 1);

    expect(await container.repos.workspaces.get(stale.id)).toMatchObject({ status: 'DESTROYED' });
    expect(container.logs.join('')).toContain('destroying a stalled workspace failed');
    expect((await container.repos.turns.get(turn.id))?.status).toBe('SUCCEEDED');
    vi.restoreAllMocks();
  });

  /**
   * Without both credentials there is nothing to inject, so no container is started at all and the
   * user is told where to configure them.
   */
  it('fails the turn when a credential is missing', async () => {
    const container = setup({ secrets: new FakeSecretsService({ GITHUB_PAT: GITHUB_CANARY }) });
    const { turn } = await seed(container);

    await run(container, turn.id);

    expect(container.runner.calls.some((call) => call.method === 'create')).toBe(false);
    expect((await container.repos.turns.get(turn.id))?.error).toContain('secrets_missing');
    expect([...container.repos.store.workspaces.values()][0]?.status).toBe('FAILED');
    expect(container.publisher.eventsFor(turn.id).at(-1)).toMatchObject({ type: 'turn.failed' });
  });

  /**
   * A missing image is reported with the command that builds it, because that is the only thing
   * the user can do about it.
   */
  it('fails the turn when the workspace image is missing', async () => {
    const container = setup({ runner: (options) => new ImagelessRunner(options) });
    const { turn } = await seed(container);

    await run(container, turn.id);

    const failed = await container.repos.turns.get(turn.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error).toContain('workspace_image_missing');
    expect(failed?.error).toContain('pnpm infra:image');
  });

  /**
   * A runtime that reports its own failure is recorded verbatim, and its workspace goes back to
   * ready: the container is fine, the turn is not.
   */
  it('records a failure the runtime reported', async () => {
    const container = setup({
      script: scriptedRuntime([
        { type: 'turn.started', turnId: 'x', at: '2026-01-01T00:00:00.000Z' },
        { type: 'turn.failed', error: { code: 'auth', message: 'OpenAI rejected the API key' } },
      ]),
    });
    const { chat, turn } = await seed(container);

    await run(container, turn.id);

    expect((await container.repos.turns.get(turn.id))?.error).toBe(
      'auth: OpenAI rejected the API key',
    );
    expect((await container.repos.workspaces.findLiveByChat(chat.id))?.status).toBe('READY');
  });

  /**
   * A runtime that dies without saying why leaves the exit code as the only evidence, so that is
   * what the turn records — and the UI still receives a `turn.failed` to end its stream.
   */
  it('fails the turn when the runtime exits non-zero without a terminal event', async () => {
    const container = setup({
      script: scriptedRuntime([{ type: 'prepare.progress', message: 'Cloning…' }], { exitCode: 2 }),
    });
    const { turn } = await seed(container);

    await run(container, turn.id);

    expect((await container.repos.turns.get(turn.id))?.error).toContain(
      'runtime exited with code 2',
    );
    expect(container.publisher.eventsFor(turn.id).at(-1)).toMatchObject({
      type: 'turn.failed',
      error: { code: 'runtime_exit' },
    });
  });

  /**
   * A runtime that exits cleanly but never reported an outcome is a failure too: silence is not a
   * result.
   */
  it('fails the turn when the runtime exits zero without a terminal event', async () => {
    const container = setup({ script: scriptedRuntime([]) });
    const { turn } = await seed(container);

    await run(container, turn.id);

    expect((await container.repos.turns.get(turn.id))?.error).toContain(
      'runtime ended without a terminal event',
    );
  });

  /**
   * The runner's wall-clock backstop is reported as a timeout rather than as an exit code.
   */
  it('fails the turn when the runner reports a timeout', async () => {
    const container = setup({
      script: {
        match: (cmd: readonly string[]) => cmd[0] === 'node',
        events: [{ type: 'exit', code: null, signal: 'TIMEOUT' }],
      },
    });
    const { turn } = await seed(container);

    await run(container, turn.id);

    expect((await container.repos.turns.get(turn.id))?.error).toContain('turn timed out');
  });

  /**
   * Cancelling signals the running exec and records the turn as cancelled, leaving the workspace
   * usable for the next message. The runtime here never acknowledges the signal, which is the
   * case the worker has to close out on its own.
   */
  it('cancels a running turn and releases its workspace', async () => {
    const container = setup({
      script: scriptedRuntime(
        [
          { type: 'turn.started', turnId: 'x', at: '2026-01-01T00:00:00.000Z' },
          { type: 'prepare.progress', message: 'Cloning…' },
        ],
        { holdUntilSignal: { afterEvent: 2 } },
      ),
    });
    const { chat, turn } = await seed(container);
    const publish = container.publisher.publish.bind(container.publisher);
    vi.spyOn(container.publisher, 'publish').mockImplementation(async (turnId, event) => {
      const id = await publish(turnId, event);
      if (event.type === 'prepare.progress') {
        container.commands.emitCancel(turnId);
      }
      return id;
    });

    await run(container, turn.id);

    expect(
      container.runner.calls.some((call) => call.method === 'signal' && call.args[2] === 'INT'),
    ).toBe(true);
    expect((await container.repos.turns.get(turn.id))?.status).toBe('CANCELLED');
    expect(container.publisher.eventsFor(turn.id).at(-1)).toEqual({ type: 'turn.cancelled' });
    expect((await container.repos.workspaces.findLiveByChat(chat.id))?.status).toBe('READY');
    expect(container.commands.subscriptions).toBe(0);
    vi.restoreAllMocks();
  });

  /**
   * A runtime that answers the signal reports the cancellation itself, and the worker records it
   * once rather than twice.
   */
  it('records a cancellation the runtime acknowledged', async () => {
    const container = setup({
      script: scriptedRuntime([
        { type: 'turn.started', turnId: 'x', at: '2026-01-01T00:00:00.000Z' },
        { type: 'turn.cancelled' },
      ]),
    });
    const { turn } = await seed(container);

    await run(container, turn.id);

    expect((await container.repos.turns.get(turn.id))?.status).toBe('CANCELLED');
    expect(
      container.publisher.eventsFor(turn.id).filter((event) => event.type === 'turn.cancelled'),
    ).toHaveLength(1);
  });

  /**
   * Credentials reach the container's environment and must reach nothing else. Everything the
   * runtime says about them is scrubbed before it is published or written.
   */
  it('lets no credential reach a published event or a persisted row', async () => {
    const container = setup({
      script: scriptedRuntime([
        { type: 'turn.started', turnId: 'x', at: '2026-01-01T00:00:00.000Z' },
        {
          type: 'tool.call',
          callId: 'call-1',
          name: 'run_shell',
          args: { command: `curl -H "Authorization: Bearer ${OPENAI_CANARY}" https://api` },
          seq: 1,
        },
        {
          type: 'tool.output.delta',
          callId: 'call-1',
          stream: 'stdout',
          text: `token=${GITHUB_CANARY}`,
        },
        {
          type: 'tool.result',
          callId: 'call-1',
          exitCode: 0,
          bytes: 10,
          durationMs: 5,
          status: 'SUCCEEDED',
        },
        {
          type: 'turn.completed',
          usage: { inputTokens: 1, outputTokens: 1 },
          steps: 1,
          finalMessage: `done with ${OPENAI_CANARY}`,
        },
      ]),
    });
    const { turn } = await seed(container);

    await run(container, turn.id);

    const published = JSON.stringify(container.publisher.records);
    expect(() => {
      assertNoCanary(published);
    }).not.toThrow();
    expect(published).toContain('[REDACTED]');
    expect(() => {
      assertNoCanary(persistedText(container));
    }).not.toThrow();
    expect(() => {
      assertNoCanary(container.logs.join(''));
    }).not.toThrow();
  });

  /**
   * The exec stream cuts wherever the socket does, and a line the runtime garbled is reported as a
   * protocol error without stopping the turn.
   */
  it('survives split chunks and an invalid line', async () => {
    const tail = scriptedRuntime(
      [
        { type: 'turn.started', turnId: 'x', at: '2026-01-01T00:00:00.000Z' },
        {
          type: 'turn.completed',
          usage: { inputTokens: 1, outputTokens: 1 },
          steps: 1,
          finalMessage: 'ok',
        },
      ],
      { splitChunks: true },
    );
    const container = setup({
      script: {
        match: tail.match,
        events: async function* mixed(spec: ExecSpec, signal: AbortSignal) {
          yield {
            type: 'stdout',
            data: new TextEncoder().encode('{"type":"nonsense"}\n'),
          } as const;
          if (typeof tail.events !== 'function') {
            return;
          }
          yield* tail.events(spec, signal);
        },
      },
    });
    const { turn } = await seed(container);

    await run(container, turn.id);

    expect(container.publisher.eventsFor(turn.id).at(0)).toMatchObject({
      type: 'protocol.error',
      reason: 'schema-violation',
    });
    expect((await container.repos.turns.get(turn.id))?.status).toBe('SUCCEEDED');
    expect(container.logs.join('')).toContain('runtime produced an invalid line');
  });

  /**
   * An unreachable daemon is the one failure worth retrying, so the job rejects and the workspace
   * is recorded as failed rather than handed to the next turn.
   */
  it('rejects and fails the workspace when the daemon is unreachable', async () => {
    const container = setup({
      runner: (options) => new UnreachableRunner(connectionRefused(), options),
    });
    const { chat, turn } = await seed(container);

    await expect(run(container, turn.id)).rejects.toThrow(/unreachable/);

    expect((await container.repos.turns.get(turn.id))?.status).toBe('FAILED');
    expect([...container.repos.store.workspaces.values()][0]?.status).toBe('FAILED');
    expect(await container.repos.workspaces.findLiveByChat(chat.id)).toBeNull();
  });

  /**
   * The same is true when the daemon is already unreachable at create time: the job rejects rather
   * than recording a turn that never had a chance to run.
   */
  it('rejects when the daemon is unreachable while creating the workspace', async () => {
    const container = setup({
      runner: (options) => new UncreatableRunner(connectionRefused(), options),
    });
    const { turn } = await seed(container);

    await expect(run(container, turn.id)).rejects.toThrow(/ECONNREFUSED/);

    expect([...container.repos.store.workspaces.values()][0]).toMatchObject({
      status: 'FAILED',
      failureReason: 'docker unreachable',
    });
  });

  /**
   * Any other runner failure would repeat on a retry, so the turn simply fails and the job is
   * acknowledged.
   */
  it('resolves when the runner fails for a reason a retry would repeat', async () => {
    const container = setup({
      runner: (options) => new UnreachableRunner(new Error('exec is not supported here'), options),
    });
    const { turn } = await seed(container);

    await run(container, turn.id);

    expect((await container.repos.turns.get(turn.id))?.error).toContain('runner_error');
  });

  /**
   * A turn that is gone, or already finished, is acknowledged without touching anything: BullMQ
   * redelivers, and a redelivered turn must not run twice.
   */
  it('skips an unknown or already finished turn', async () => {
    const container = setup();
    const { turn } = await seed(container);
    await container.repos.turns.finish(turn.id, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });

    await run(container, 'no-such-turn');
    await run(container, turn.id);

    expect(container.runner.calls).toHaveLength(0);
    expect(container.publisher.records).toHaveLength(0);
  });

  /**
   * A turn whose chat was deleted has nothing to answer.
   */
  it('fails a turn whose chat is gone', async () => {
    const container = setup();
    const { chat, turn } = await seed(container);
    container.repos.store.chats.delete(chat.id);

    await run(container, turn.id);

    expect((await container.repos.turns.get(turn.id))?.error).toContain('chat_not_found');
  });

  /**
   * A request the protocol rejects — a chat whose repository URL predates validation, say — must
   * still leave the turn terminal and the workspace usable.
   */
  it('settles the turn when preparing the request throws', async () => {
    const container = setup();
    const { chat, turn } = await seed(container, { repoUrl: 'not a url' });

    await expect(run(container, turn.id)).rejects.toThrow();

    const failed = await container.repos.turns.get(turn.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error).toContain('worker error');
    expect((await container.repos.workspaces.findLiveByChat(chat.id))?.status).toBe('READY');
  });
});

describe('createRunTurnProcessor, racing another turn of the same chat', () => {
  /**
   * Builds a container whose workspace creation always loses the race.
   *
   * @param container - The container to wrap.
   * @param existing - What the post-conflict lookup finds.
   * @returns A container with the conflicting repositories.
   */
  function withConflict(
    container: TestContainer,
    existing: () => Promise<Workspace | null>,
  ): TestContainer {
    const base = container.repos.workspaces;
    const workspaces: WorkspaceRepository = {
      create: () => Promise.reject(new LiveWorkspaceExistsError('chat')),
      findLiveByChat: existing,
      setStatus: (id, status, update) => base.setStatus(id, status, update),
      markActive: (id) => base.markActive(id),
      listIdle: (before) => base.listIdle(before),
      listLive: () => base.listLive(),
      get: (id) => base.get(id),
    };
    const repos: Repositories = { ...container.repos, workspaces };
    return { ...container, repos: { ...container.repos, ...repos } };
  }

  /**
   * The other turn already built the container this chat may have, so this one joins it instead of
   * failing: the chat's turns share the single workspace the database allows it.
   */
  it('joins the workspace the other turn created', async () => {
    const container = setup({ script: scriptedRuntime(happyScript()) });
    const { chat, turn } = await seed(container);
    const existing = await container.repos.workspaces.create({
      kind: 'CHAT',
      chatId: chat.id,
      runnerKind: 'fake',
      image: 'image',
      repoUrl: REPO_URL,
      branch: 'main',
    });
    await container.repos.workspaces.setStatus(existing.id, 'READY', { runnerRef: 'ref-1' });
    await container.runner.create({
      workspaceId: existing.id,
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits: { cpus: 1, memoryBytes: 1, pids: 1 },
      labels: {},
    });
    // The create branch is reached only when the lookups that precede it found nothing — the
    // stalled-workspace check and the health review — so the row is hidden from those two and
    // revealed to the one that follows the conflict.
    let lookups = 0;
    const raced = withConflict(container, () => {
      lookups += 1;
      return lookups <= 2
        ? Promise.resolve(null)
        : container.repos.workspaces.findLiveByChat(chat.id);
    });

    await createRunTurnProcessor(raced)(job(turn.id));

    const finished = await container.repos.turns.get(turn.id);
    expect(finished?.workspaceId).toBe(existing.id);
    expect(finished?.status).toBe('SUCCEEDED');
  });

  /**
   * When the conflicting workspace is gone by the time it is looked up, the turn fails with an
   * explanation instead of creating a second live workspace the database forbids.
   */
  it('fails the turn when the conflicting workspace cannot be found', async () => {
    const container = setup();
    const { turn } = await seed(container);
    const raced = withConflict(container, () => Promise.resolve(null));

    await createRunTurnProcessor(raced)(job(turn.id));

    expect((await container.repos.turns.get(turn.id))?.error).toContain(WORKSPACE_CONFLICT_CODE);
  });
});
