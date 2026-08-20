/**
 * Unit tests for the failure and cancellation paths of the `run-turn` processor.
 *
 * Layer: unit.
 * Goal: every way a turn can end badly leaves a terminal turn, a usable workspace and a stream the
 * UI can close — and no credential in any of them; plus the one failure worth retrying and the
 * race with another writer of the same chat.
 * Mocks: the shared processor fixtures, plus a repository double that always loses the create race.
 */
import { LiveWorkspaceExistsError } from '@agent-hangar/core';
import type { ExecSpec, Repositories, Workspace, WorkspaceRepository } from '@agent-hangar/core';
import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  connectionRefused,
  FakeSecretsService,
  FIXTURE_REPO_URL,
  happyTurnScript,
  ImagelessRunner,
  persistedText,
  runTurnOn,
  scriptedRuntime,
  seedChatWithTurn,
  setupProcessorContainer,
  turnJob,
  UncreatableRunner,
  UnreachableRunner,
} from '../testing/index.js';
import type { TestContainer } from '../testing/index.js';

import { createRunTurnProcessor, WORKSPACE_CONFLICT_CODE } from './run-turn.js';

describe('createRunTurnProcessor, failing a turn', () => {
  /**
   * Without both credentials there is nothing to inject, so no container is started at all and the
   * user is told where to configure them.
   */
  it('fails the turn when a credential is missing', async () => {
    const container = setupProcessorContainer({
      secrets: new FakeSecretsService({ GITHUB_PAT: GITHUB_CANARY }),
    });
    const { turn } = await seedChatWithTurn(container);

    await runTurnOn(container, turn.id);

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
    const container = setupProcessorContainer({
      runner: (options) => new ImagelessRunner(options),
    });
    const { turn } = await seedChatWithTurn(container);

    await runTurnOn(container, turn.id);

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
    const container = setupProcessorContainer({
      script: scriptedRuntime([
        { type: 'turn.started', turnId: 'x', at: '2026-01-01T00:00:00.000Z' },
        { type: 'turn.failed', error: { code: 'auth', message: 'OpenAI rejected the API key' } },
      ]),
    });
    const { chat, turn } = await seedChatWithTurn(container);

    await runTurnOn(container, turn.id);

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
    const container = setupProcessorContainer({
      script: scriptedRuntime([{ type: 'prepare.progress', message: 'Cloning…' }], { exitCode: 2 }),
    });
    const { turn } = await seedChatWithTurn(container);

    await runTurnOn(container, turn.id);

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
    const container = setupProcessorContainer({ script: scriptedRuntime([]) });
    const { turn } = await seedChatWithTurn(container);

    await runTurnOn(container, turn.id);

    expect((await container.repos.turns.get(turn.id))?.error).toContain(
      'runtime ended without a terminal event',
    );
  });

  /**
   * The runner's wall-clock backstop is reported as a timeout rather than as an exit code.
   */
  it('fails the turn when the runner reports a timeout', async () => {
    const container = setupProcessorContainer({
      script: {
        match: (cmd: readonly string[]) => cmd[0] === 'node',
        events: [{ type: 'exit', code: null, signal: 'TIMEOUT' }],
      },
    });
    const { turn } = await seedChatWithTurn(container);

    await runTurnOn(container, turn.id);

    expect((await container.repos.turns.get(turn.id))?.error).toContain('turn timed out');
  });

  /**
   * Cancelling signals the running exec and records the turn as cancelled, leaving the workspace
   * usable for the next message. The runtime here never acknowledges the signal, which is the
   * case the worker has to close out on its own.
   */
  it('cancels a running turn and releases its workspace', async () => {
    const container = setupProcessorContainer({
      script: scriptedRuntime(
        [
          { type: 'turn.started', turnId: 'x', at: '2026-01-01T00:00:00.000Z' },
          { type: 'prepare.progress', message: 'Cloning…' },
        ],
        { holdUntilSignal: { afterEvent: 2 } },
      ),
    });
    const { chat, turn } = await seedChatWithTurn(container);
    const publish = container.publisher.publish.bind(container.publisher);
    vi.spyOn(container.publisher, 'publish').mockImplementation(async (turnId, event) => {
      const id = await publish(turnId, event);
      if (event.type === 'prepare.progress') {
        container.commands.emitCancel(turnId);
      }
      return id;
    });

    await runTurnOn(container, turn.id);

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
   * Stop is offered from the moment a message is sent, and creating the container and cloning the
   * repository is the slow part the user watches. A cancellation published during it reaches a
   * worker that is already listening, and the turn ends without ever starting the runtime.
   */
  it('cancels a turn stopped while its workspace was being prepared', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyTurnScript()) });
    const { chat, turn } = await seedChatWithTurn(container);
    const create = container.runner.create.bind(container.runner);
    vi.spyOn(container.runner, 'create').mockImplementation(async (spec) => {
      const handle = await create(spec);
      container.commands.emitCancel(turn.id);
      return handle;
    });

    await runTurnOn(container, turn.id);

    expect((await container.repos.turns.get(turn.id))?.status).toBe('CANCELLED');
    expect(container.publisher.eventsFor(turn.id).at(-1)).toEqual({ type: 'turn.cancelled' });
    expect(container.runner.calls.some((call) => call.method === 'exec')).toBe(false);
    expect((await container.repos.workspaces.findLiveByChat(chat.id))?.status).toBe('READY');
    expect(container.commands.subscriptions).toBe(0);
    vi.restoreAllMocks();
  });

  /**
   * A runtime that answers the signal reports the cancellation itself, and the worker records it
   * once rather than twice.
   */
  it('records a cancellation the runtime acknowledged', async () => {
    const container = setupProcessorContainer({
      script: scriptedRuntime([
        { type: 'turn.started', turnId: 'x', at: '2026-01-01T00:00:00.000Z' },
        { type: 'turn.cancelled' },
      ]),
    });
    const { turn } = await seedChatWithTurn(container);

    await runTurnOn(container, turn.id);

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
    const container = setupProcessorContainer({
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
    const { turn } = await seedChatWithTurn(container);

    await runTurnOn(container, turn.id);

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
    const container = setupProcessorContainer({
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
    const { turn } = await seedChatWithTurn(container);

    await runTurnOn(container, turn.id);

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
    const container = setupProcessorContainer({
      runner: (options) => new UnreachableRunner(connectionRefused(), options),
    });
    const { chat, turn } = await seedChatWithTurn(container);

    await expect(runTurnOn(container, turn.id)).rejects.toThrow(/unreachable/);

    expect((await container.repos.turns.get(turn.id))?.status).toBe('FAILED');
    expect([...container.repos.store.workspaces.values()][0]?.status).toBe('FAILED');
    expect(await container.repos.workspaces.findLiveByChat(chat.id)).toBeNull();
  });

  /**
   * The same is true when the daemon is already unreachable at create time: the job rejects rather
   * than recording a turn that never had a chance to run.
   */
  it('rejects when the daemon is unreachable while creating the workspace', async () => {
    const container = setupProcessorContainer({
      runner: (options) => new UncreatableRunner(connectionRefused(), options),
    });
    const { turn } = await seedChatWithTurn(container);

    await expect(runTurnOn(container, turn.id)).rejects.toThrow(/ECONNREFUSED/);

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
    const container = setupProcessorContainer({
      runner: (options) => new UnreachableRunner(new Error('exec is not supported here'), options),
    });
    const { turn } = await seedChatWithTurn(container);

    await runTurnOn(container, turn.id);

    expect((await container.repos.turns.get(turn.id))?.error).toContain('runner_error');
  });

  /**
   * A turn that is gone, or already finished, is acknowledged without touching anything: BullMQ
   * redelivers, and a redelivered turn must not run twice.
   */
  it('skips an unknown or already finished turn', async () => {
    const container = setupProcessorContainer();
    const { turn } = await seedChatWithTurn(container);
    await container.repos.turns.finish(turn.id, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });

    await runTurnOn(container, 'no-such-turn');
    await runTurnOn(container, turn.id);

    expect(container.runner.calls).toHaveLength(0);
    expect(container.publisher.records).toHaveLength(0);
  });

  /**
   * A turn whose chat was deleted has nothing to answer.
   */
  it('fails a turn whose chat is gone', async () => {
    const container = setupProcessorContainer();
    const { chat, turn } = await seedChatWithTurn(container);
    container.repos.store.chats.delete(chat.id);

    await runTurnOn(container, turn.id);

    expect((await container.repos.turns.get(turn.id))?.error).toContain('chat_not_found');
  });

  /**
   * A request the protocol rejects — a chat whose stored base branch predates validation, say —
   * must still leave the turn terminal and the workspace usable. The repository URL cannot play
   * that role any more: provisioning measures it against the allow-list first, so a stored URL the
   * protocol would refuse never reaches the request builder.
   */
  it('settles the turn when preparing the request throws', async () => {
    const container = setupProcessorContainer();
    const { chat, turn } = await seedChatWithTurn(container, { baseBranch: '' });

    await expect(runTurnOn(container, turn.id)).rejects.toThrow();

    const failed = await container.repos.turns.get(turn.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error).toContain('worker error');
    expect((await container.repos.workspaces.findLiveByChat(chat.id))?.status).toBe('READY');
  });

  /**
   * Removing an origin from `ALLOWED_REPO_HOSTS` has to stop the chats already pointed at it. A
   * chat whose container is still running never provisions again, so checking only where a
   * workspace is created would leave that container pushing to the removed forge with the PAT for
   * as long as the idle collector left it standing. The second turn is refused instead.
   */
  it('refuses a further turn once the chat repository leaves the allow-list', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyTurnScript()) });
    const { chat, turn } = await seedChatWithTurn(container);
    await runTurnOn(container, turn.id);
    expect(await container.repos.workspaces.findLiveByChat(chat.id)).not.toBeNull();

    const restricted: TestContainer = {
      ...container,
      config: { ...container.config, ALLOWED_REPO_HOSTS: 'git.example.test' },
    };
    const second = await container.repos.turns.create({ chatId: chat.id, model: 'test-model' });
    container.runner.calls.length = 0;
    await runTurnOn(restricted, second.id);

    const refused = await container.repos.turns.get(second.id);
    expect(refused?.status).toBe('FAILED');
    expect(refused?.error).toContain('repo_url_not_allowed');
    expect(container.runner.calls).toHaveLength(0);
  });
});

describe('createRunTurnProcessor, racing another writer of the same chat', () => {
  /**
   * Builds a container whose workspace creation always loses the race.
   *
   * The create branch is reached only when the lookups that precede it found nothing — the
   * stalled-workspace check and the health review — so the winner's row is hidden from those two
   * and revealed to any lookup that follows the conflict. A processor that adopts the row it lost
   * the race for therefore finds one to adopt.
   *
   * @param container - The container to wrap.
   * @param existing - The row a post-conflict lookup finds.
   * @returns A container whose `create` reports that the chat already has a live workspace.
   */
  function withConflict(container: TestContainer, existing: Workspace): TestContainer {
    const base = container.repos.workspaces;
    let lookups = 0;
    const workspaces: WorkspaceRepository = {
      create: () => Promise.reject(new LiveWorkspaceExistsError('chat')),
      findLiveByChat: () => {
        lookups += 1;
        return Promise.resolve(lookups <= 2 ? null : existing);
      },
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
   * "One live workspace per chat" is a database constraint, and the create it rejects is the claim
   * this turn lost. Adopting the winner's row would put two turns in one filesystem, each believing
   * it owns it, so the loser reports a conflict and the user sends the message again.
   */
  it('fails the turn rather than joining the workspace it lost the race for', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyTurnScript()) });
    const { chat, turn } = await seedChatWithTurn(container);
    const existing = await container.repos.workspaces.create({
      kind: 'CHAT',
      chatId: chat.id,
      runnerKind: 'fake',
      image: 'image',
      repoUrl: FIXTURE_REPO_URL,
      branch: 'main',
    });
    const ready = await container.repos.workspaces.setStatus(existing.id, 'READY', {
      runnerRef: 'ref-1',
    });
    await container.runner.create({
      workspaceId: existing.id,
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits: { cpus: 1, memoryBytes: 1, pids: 1 },
      labels: {},
    });

    await createRunTurnProcessor(withConflict(container, ready))(turnJob(turn.id));

    const failed = await container.repos.turns.get(turn.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error).toContain(WORKSPACE_CONFLICT_CODE);
    expect(failed?.workspaceId).toBeNull();
    expect(container.runner.calls.some((call) => call.method === 'exec')).toBe(false);
    expect(container.logs.join('')).toContain('another writer created the workspace of this chat');
  });
});
