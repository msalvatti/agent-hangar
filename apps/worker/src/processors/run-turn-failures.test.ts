/**
 * Unit tests for the failure and cancellation paths of the `run-turn` processor.
 *
 * Layer: unit.
 * Goal: every way a turn can end badly leaves a terminal turn, a usable workspace and a stream the
 * UI can close — and no credential in any of them; plus the one failure worth retrying and the two
 * races with another writer of the same chat: the create that loses the live-workspace index, and
 * the workspace taken between this turn's read of it and its conditional `BUSY` write.
 * Mocks: the shared processor fixtures, plus a repository double that always loses the create race.
 */
import { LiveWorkspaceExistsError, NotFoundError } from '@agent-hangar/core';
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

import { WORKER_ERROR_PREFIX } from './constants.js';
import { createRunTurnProcessor, WORKSPACE_CONFLICT_CODE } from './run-turn.js';

/** The records the container collected, parsed back from the lines pino wrote. */
function records(logs: string[]): Record<string, unknown>[] {
  return logs.map((line) => JSON.parse(line) as Record<string, unknown>);
}

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
  it('counts the highest step and keeps nothing from the live-view events', async () => {
    const container = setupProcessorContainer({
      script: scriptedRuntime([
        { type: 'turn.started', turnId: 'x', at: '2026-01-01T00:00:00.000Z' },
        { type: 'prepare.progress', message: 'Cloning…' },
        { type: 'heartbeat', at: '2026-01-01T00:00:01.000Z' },
        { type: 'assistant.delta', text: 'thinking' },
        { type: 'assistant.message', text: 'done thinking' },
        { type: 'protocol.error', reason: 'schema-violation', length: 12 },
        { type: 'step.started', step: 3 },
        { type: 'step.started', step: 2 },
        { type: 'turn.failed', error: { code: 'runtime_exit', message: 'the runtime gave up' } },
      ]),
    });
    const { chat, turn } = await seedChatWithTurn(container);

    await runTurnOn(container, turn.id);

    // Every one of those events is named in the sink, six of them deliberately kept nowhere. The
    // step count is the highest reached rather than the last reported: steps can arrive out of
    // order when one ends after the next begins, and a turn that did three would be recorded as
    // having done two.
    expect(await container.repos.turns.get(turn.id)).toMatchObject({
      status: 'FAILED',
      stepCount: 3,
    });
    // And none of the six left a message behind: a stored SYSTEM line is part of the window every
    // later turn of this chat carries.
    expect(await container.repos.messages.listByChat(chat.id)).toHaveLength(1);
  });

  /**
   * A cancelled turn records what it spent as well, for the same reason a failed one does.
   */
  it('records what a cancelled turn had spent', async () => {
    const container = setupProcessorContainer({
      script: scriptedRuntime([
        { type: 'turn.started', turnId: 'x', at: '2026-01-01T00:00:00.000Z' },
        { type: 'step.started', step: 2 },
        { type: 'turn.cancelled' },
      ]),
    });
    const { turn } = await seedChatWithTurn(container);

    await runTurnOn(container, turn.id);

    expect(await container.repos.turns.get(turn.id)).toMatchObject({
      status: 'CANCELLED',
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 2,
    });
  });

  it('records a failure the runtime reported', async () => {
    const container = setupProcessorContainer({
      script: scriptedRuntime([
        { type: 'turn.started', turnId: 'x', at: '2026-01-01T00:00:00.000Z' },
        { type: 'turn.failed', error: { code: 'auth', message: 'OpenAI rejected the API key' } },
      ]),
    });
    const { chat, turn } = await seedChatWithTurn(container);

    await runTurnOn(container, turn.id);

    expect(await container.repos.turns.get(turn.id)).toMatchObject({
      status: 'FAILED',
      error: 'auth: OpenAI rejected the API key',
      // A turn that failed still cost what it spent getting there, and the row is where that is
      // read from. Recorded as nothing, a failed turn reads as one that never started — and the
      // start stamp is what tells the UI the difference.
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
    expect((await container.repos.turns.get(turn.id))?.startedAt).not.toBeNull();
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
   * An unreachable daemon is reported as infrastructure, so the job is failed and the workspace
   * is recorded as failed rather than handed to the next turn.
   */
  it('rejects and fails the workspace when the daemon is unreachable', async () => {
    const container = setupProcessorContainer({
      runner: (options) => new UnreachableRunner(connectionRefused(), options),
    });
    const { chat, turn } = await seedChatWithTurn(container);

    await expect(runTurnOn(container, turn.id)).rejects.toThrow(/unreachable/);

    expect((await container.repos.turns.get(turn.id))?.status).toBe('FAILED');
    // The reason on the row says the daemon, not the turn: this workspace is not handed to the
    // next turn of the chat, and an operator reading the row has to know it was the host.
    expect([...container.repos.store.workspaces.values()][0]).toMatchObject({
      status: 'FAILED',
      failureReason: 'docker unreachable',
    });
    expect(await container.repos.workspaces.findLiveByChat(chat.id)).toBeNull();
  });

  /**
   * The same is true when the daemon is already unreachable at create time — and the turn still
   * ends. Rejecting is how the operator learns the daemon is down, but nothing redelivers the job:
   * `attempts` is zero and no default job options are declared, so a turn left non-terminal here
   * would sit `PREPARING` for ever with an empty event stream and a page waiting on it. Measured
   * before this was so: status `PREPARING`, error `null`, no events at all.
   */
  it('rejects and still ends the turn when the daemon is unreachable while creating', async () => {
    const container = setupProcessorContainer({
      runner: (options) => new UncreatableRunner(connectionRefused(), options),
    });
    const { turn } = await seedChatWithTurn(container);

    await expect(runTurnOn(container, turn.id)).rejects.toThrow(/ECONNREFUSED/);

    expect([...container.repos.store.workspaces.values()][0]).toMatchObject({
      status: 'FAILED',
      failureReason: 'docker unreachable',
    });
    const failed = await container.repos.turns.get(turn.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error).toContain(WORKER_ERROR_PREFIX);
    expect(container.publisher.eventsFor(turn.id).at(-1)).toMatchObject({ type: 'turn.failed' });
  });

  /**
   * The net is the last thing between the user and a turn that never ends, so it must not become
   * the thing that hides why. A worker that cannot reach Docker usually cannot reach Postgres
   * either; the record it fails to write is worth a log line, and the failure the operator has to
   * see is still the one that started it.
   */
  it('reports the original failure when the record it writes cannot be written', async () => {
    const container = setupProcessorContainer({
      runner: (options) => new UncreatableRunner(connectionRefused(), options),
    });
    const { turn } = await seedChatWithTurn(container);
    vi.spyOn(container.repos.turns, 'finish').mockRejectedValue(new Error('the database is down'));

    await expect(runTurnOn(container, turn.id)).rejects.toThrow(/ECONNREFUSED/);

    expect(container.logs.join('')).toContain(
      'recording the outcome of a turn its delivery never finished failed',
    );
    vi.restoreAllMocks();
  });

  /**
   * A turn the processor did record keeps the record it wrote. The outcome the runtime reported is
   * the one the user is owed, so the safety net above must not overwrite it — and must not publish
   * a second terminal event on a stream the UI has already closed.
   */
  it('leaves the recorded outcome alone when the exec transport fails', async () => {
    const container = setupProcessorContainer({
      runner: (options) => new UnreachableRunner(connectionRefused(), options),
    });
    const { turn } = await seedChatWithTurn(container);

    await expect(runTurnOn(container, turn.id)).rejects.toThrow(/unreachable/);

    const failed = await container.repos.turns.get(turn.id);
    expect(failed?.error).not.toContain(WORKER_ERROR_PREFIX);
    expect(
      container.publisher.eventsFor(turn.id).filter((event) => event.type === 'turn.failed'),
    ).toHaveLength(1);
  });

  /**
   * Any other runner failure is a result of the work, so the turn simply fails and the job is
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
    // The turn is named on both lines. A delivery skipped without saying which turn it was about
    // is a delivery nobody can match to the message the user is still waiting on.
    expect(records(container.logs)).toStrictEqual([
      expect.objectContaining({
        msg: 'run-turn skipped: the turn is gone or already finished',
        turnId: 'no-such-turn',
      }),
      expect.objectContaining({
        msg: 'run-turn skipped: the turn is gone or already finished',
        turnId: turn.id,
      }),
    ]);
  });

  /**
   * A turn whose chat was deleted has nothing to answer.
   */
  it('fails a turn whose chat is gone', async () => {
    const container = setupProcessorContainer();
    const { chat, turn } = await seedChatWithTurn(container);
    container.repos.store.chats.delete(chat.id);

    await runTurnOn(container, turn.id);

    // The whole sentence, which is what the user reads under a turn that never ran: a code with no
    // explanation beside it is not something anyone can act on.
    expect((await container.repos.turns.get(turn.id))?.error).toBe(
      'chat_not_found: the chat this turn belongs to no longer exists',
    );
  });

  /**
   * The watch opens before the first row is read, so a Stop pressed while the worker is still
   * looking the chat up reaches a subscriber — and `POST /api/turns/:id/cancel` has already
   * answered `202` to it. The chat being gone is a reason the turn could not have run, but it is
   * not a reason to record something other than what the user was promised, so the row reads
   * `CANCELLED` and the stream still ends.
   */
  it('cancels a turn whose chat is gone when the user stopped it first', async () => {
    const container = setupProcessorContainer();
    const { chat, turn } = await seedChatWithTurn(container);
    container.repos.store.chats.delete(chat.id);
    const getTurn = container.repos.turns.get.bind(container.repos.turns);
    vi.spyOn(container.repos.turns, 'get').mockImplementation(async (id) => {
      // Emitted from the very first lookup the delivery makes: a subscriber has to be in place
      // already for this to reach anyone.
      expect(container.commands.emitCancel(turn.id)).toBe(true);
      return getTurn(id);
    });

    await runTurnOn(container, turn.id);
    vi.restoreAllMocks();

    const closed = await container.repos.turns.get(turn.id);
    expect(closed?.status).toBe('CANCELLED');
    expect(closed?.error).toBeNull();
    expect(container.publisher.eventsFor(turn.id)).toEqual([{ type: 'turn.cancelled' }]);
    expect(container.runner.calls).toHaveLength(0);
    expect(container.commands.subscriptions).toBe(0);
  });

  /**
   * Preparing the workspace is the slow part the user watches, and the two ways out of it must
   * agree. A Stop that lands while preparation succeeds is already honoured by the check that
   * follows it; one that lands while preparation fails must be honoured too, instead of recording
   * the preparation failure over an answer the cancel route already gave. The Stop is emitted from
   * the workspace row provisioning opens, which is after the turn is marked `PREPARING` and before
   * the image is found missing.
   */
  it('cancels a turn stopped while the workspace it never got was failing', async () => {
    const container = setupProcessorContainer({
      runner: (options) => new ImagelessRunner(options),
    });
    const { turn } = await seedChatWithTurn(container);
    const create = container.repos.workspaces.create.bind(container.repos.workspaces);
    vi.spyOn(container.repos.workspaces, 'create').mockImplementation(async (input) => {
      const row = await create(input);
      expect(container.commands.emitCancel(turn.id)).toBe(true);
      return row;
    });

    await runTurnOn(container, turn.id);
    vi.restoreAllMocks();

    const closed = await container.repos.turns.get(turn.id);
    expect(closed?.status).toBe('CANCELLED');
    expect(closed?.error).toBeNull();
    expect(container.publisher.eventsFor(turn.id).at(-1)).toEqual({ type: 'turn.cancelled' });
    expect([...container.repos.store.workspaces.values()][0]?.status).toBe('FAILED');
    expect(container.runner.calls.some((call) => call.method === 'exec')).toBe(false);
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
      claimStatus: (id, from, to, update) => base.claimStatus(id, from, to, update),
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

  /**
   * The collector can select a workspace as idle while a turn is still preparing to use it, and a
   * second worker process sees none of this one's in-process bookkeeping. Taking the workspace is
   * therefore a conditional write from `READY`, and this test moves the row underneath the turn
   * exactly where the window is: while the turn is recording which workspace it will run in.
   *
   * What is asserted is the outcome, not the call. The row still reads what the other writer put
   * there rather than `BUSY`, nothing was executed in the container, and the turn is terminal with
   * the conflict the user can act on.
   */
  it('fails the turn rather than executing in a workspace another writer took', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyTurnScript()) });
    const { turn } = await seedChatWithTurn(container);
    const setStatus = container.repos.turns.setStatus.bind(container.repos.turns);
    vi.spyOn(container.repos.turns, 'setStatus').mockImplementation(async (id, status, update) => {
      const row = await setStatus(id, status, update);
      if (update?.workspaceId !== undefined && update.workspaceId !== null) {
        await container.repos.workspaces.setStatus(update.workspaceId, 'STOPPING');
      }
      return row;
    });

    await createRunTurnProcessor(container)(turnJob(turn.id));

    const failed = await container.repos.turns.get(turn.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error).toContain(WORKSPACE_CONFLICT_CODE);
    expect(container.runner.calls.some((call) => call.method === 'exec')).toBe(false);
    expect([...container.repos.store.workspaces.values()][0]?.status).toBe('STOPPING');
    // Both identifiers on the line: the turn that could not proceed and the workspace it wanted.
    // Two writers reaching for one container is exactly the case an operator has to be able to
    // reconstruct, and neither id can be recovered from the other.
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: "another writer took this chat's workspace first",
        turnId: turn.id,
        workspaceId: [...container.repos.store.workspaces.values()][0]?.id,
      }),
    );
    vi.restoreAllMocks();
  });
});

describe('createRunTurnProcessor, when another writer got there first', () => {
  /**
   * A chat has one live workspace, and the database says so. Two deliveries of two turns of the
   * same chat can reach the create together — one in each of two workers — and the one that loses
   * is told by the row itself. It is refused rather than retried, because the workspace that now
   * exists belongs to the turn that won and this one has no claim on it.
   */
  it('refuses the turn whose create the row refused, naming the chat', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyTurnScript()) });
    const { chat, turn } = await seedChatWithTurn(container);
    vi.spyOn(container.repos.workspaces, 'create').mockRejectedValueOnce(
      new LiveWorkspaceExistsError(chat.id),
    );

    await runTurnOn(container, turn.id);

    const refused = await container.repos.turns.get(turn.id);
    expect(refused?.status).toBe('FAILED');
    expect(refused?.error).toBe(
      'workspace_conflict: The workspace of this chat is busy with another operation; ' +
        'send the message again in a moment.',
    );
    expect(container.runner.calls.some((call) => call.method === 'exec')).toBe(false);
    // The chat is on the line: the workspace this turn lost belongs to the chat, not to the turn,
    // and the chat is the only identifier both writers share.
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'another writer created the workspace of this chat first',
        chatId: chat.id,
      }),
    );
    vi.restoreAllMocks();
  });

  /**
   * The wind-up releases the workspace it ran in — unless the row is no longer there to release.
   * A chat deleted mid-turn cascades its workspace away, and a wind-up that reached for the status
   * of a row that had gone would throw out of the `finally` and fail a delivery whose turn had
   * already been recorded.
   */
  it('winds a turn up whose workspace row was deleted under it', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyTurnScript()) });
    const { turn } = await seedChatWithTurn(container);
    const markActive = container.repos.workspaces.markActive.bind(container.repos.workspaces);
    vi.spyOn(container.repos.workspaces, 'markActive').mockImplementation(async (id: string) => {
      await markActive(id);
      container.repos.store.workspaces.delete(id);
    });

    await expect(runTurnOn(container, turn.id)).resolves.toBeUndefined();

    expect((await container.repos.turns.get(turn.id))?.status).toBe('SUCCEEDED');
    expect(container.repos.store.workspaces.size).toBe(0);
    vi.restoreAllMocks();
  });
});

describe('createRunTurnProcessor, winding a turn up under a delete', () => {
  /**
   * A terminal turn status does not mean this processor has finished with the turn: the outcome is
   * written while the workspace is still `BUSY`, and the wind-up that follows releases it and bumps
   * the chat's ordering key. `DELETE /api/chats/:id` refuses only while a turn is live, so it
   * becomes allowed the instant the outcome lands and can commit before that bump. The delete is
   * driven from inside the wind-up, at the workspace write that genuinely precedes the bump, and it
   * goes through the same conditional delete the route calls — which answers `DELETED`, proving the
   * caller was entitled to it. Before, the bump raised on the row that was no longer there and
   * failed the delivery, which BullMQ then redelivered for a turn that had already finished.
   */
  it('survives the chat being deleted the moment its turn finished', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyTurnScript()) });
    const { chat, turn } = await seedChatWithTurn(container);
    const outcomes: string[] = [];
    const markActive = container.repos.workspaces.markActive.bind(container.repos.workspaces);
    vi.spyOn(container.repos.workspaces, 'markActive').mockImplementation(async (id: string) => {
      await markActive(id);
      if (outcomes.length === 0) {
        outcomes.push(await container.repos.chats.deleteIfIdle(chat.id));
      }
    });

    await expect(runTurnOn(container, turn.id)).resolves.toBeUndefined();

    expect(outcomes).toEqual(['DELETED']);
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'chat was deleted while its turn was being wound up',
        chatId: chat.id,
      }),
    );
  });

  /**
   * The other side of that branch: a row reported missing under some *other* identifier is not the
   * delete this wind-up is willing to absorb, so it still fails the delivery. Comparing the type
   * alone would turn a write that went to the wrong row into a silent success.
   */
  it('still fails when the missing row is not the chat being wound up', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyTurnScript()) });
    const { turn } = await seedChatWithTurn(container);
    vi.spyOn(container.repos.chats, 'touch').mockRejectedValue(
      new NotFoundError('Chat', 'some-other-chat'),
    );

    await expect(runTurnOn(container, turn.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
