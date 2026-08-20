/**
 * Unit tests for the workspace half of the `run-turn` processor.
 *
 * Layer: unit.
 * Goal: the flow of spec 04 (a) and (b) up to the container — a first turn end to end, a live
 * workspace reused without cloning, one replaced because its container is gone or broken, and the
 * stalled recovery a worker that died mid-turn leaves behind.
 * Mocks: the shared processor fixtures over in-memory repositories, the fake runner and the real
 * redactor.
 */
import { DEFAULT_CHAT_TURN_LIMITS, isTerminalRunStatus } from '@agent-hangar/core';
import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  FIXTURE_NOTES_CONTENT,
  FIXTURE_REPO_URL,
  GoneRunner,
  happyTurnScript,
  heldTurnScript,
  lastCreateSpec,
  requestSentTo,
  runTurnOn,
  scriptedRuntime,
  seedChatWithTurn,
  setupProcessorContainer,
  TickingClock,
  UnhealthyRunner,
  whenWorkspaceIsBusy,
} from '../testing/index.js';

import { STALLED_RECOVERY_NOTE, STALLED_RECOVERY_REASON } from './constants.js';
import { WORKSPACE_CONFLICT_CODE } from './run-turn.js';

describe('createRunTurnProcessor, ensuring a workspace', () => {
  /**
   * A first message: no workspace exists, so one is created with the credentials and the labels
   * the collector selects on, the runtime is handed a cloning request built from the chat, and
   * every event it emits becomes a stream entry and a row.
   */
  it('runs a first turn end to end', async () => {
    const container = setupProcessorContainer({
      script: scriptedRuntime(happyTurnScript()),
      clock: new TickingClock(),
    });
    const { chat, turn } = await seedChatWithTurn(container);

    await runTurnOn(container, turn.id);

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
    expect(request.repo.url).toBe(FIXTURE_REPO_URL);
    expect(request.items.at(0)?.content).toBe('list files and create NOTES.md');
    expect(request.limits).toEqual(DEFAULT_CHAT_TURN_LIMITS);

    expect(container.publisher.eventsFor(turn.id)).toEqual(happyTurnScript());

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
    expect(messages[1]?.content).toBe(
      `wrote NOTES.md (${Buffer.byteLength(FIXTURE_NOTES_CONTENT)} bytes)`,
    );
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
    const container = setupProcessorContainer({ script: scriptedRuntime(happyTurnScript()) });
    const { chat, turn } = await seedChatWithTurn(container);
    await runTurnOn(container, turn.id);
    const first = (await container.repos.workspaces.findLiveByChat(chat.id))?.id;

    const second = await container.repos.turns.create({ chatId: chat.id, model: 'test-model' });
    container.runner.calls.length = 0;
    await runTurnOn(container, second.id);

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
    const container = setupProcessorContainer({
      script: scriptedRuntime(happyTurnScript()),
      runner: (options) => new GoneRunner(options),
    });
    const { chat, turn } = await seedChatWithTurn(container);
    await runTurnOn(container, turn.id);
    const second = await container.repos.turns.create({ chatId: chat.id, model: 'test-model' });

    await runTurnOn(container, second.id);

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
    const container = setupProcessorContainer({
      script: scriptedRuntime(happyTurnScript()),
      runner: (options) => new UnhealthyRunner(options),
    });
    const { chat, turn } = await seedChatWithTurn(container);
    await runTurnOn(container, turn.id);
    const second = await container.repos.turns.create({ chatId: chat.id, model: 'test-model' });

    await runTurnOn(container, second.id);

    const rows = [...container.repos.store.workspaces.values()];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'FAILED', failureReason: 'exec probe failed' });
  });

  /**
   * A workspace found `BUSY` belonged to a worker that died mid-turn: it is destroyed, the model
   * is told its filesystem is gone, and the turn runs in a fresh one.
   */
  it('recovers from a stalled previous attempt', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyTurnScript()) });
    const { chat, turn } = await seedChatWithTurn(container);
    const stalled = await container.repos.workspaces.create({
      kind: 'CHAT',
      chatId: chat.id,
      runnerKind: 'fake',
      image: 'image',
      repoUrl: FIXTURE_REPO_URL,
      branch: 'main',
    });
    await container.repos.workspaces.setStatus(stalled.id, 'READY', { runnerRef: 'ref-1' });
    await container.repos.workspaces.setStatus(stalled.id, 'BUSY');

    await runTurnOn(container, turn.id);

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
    const container = setupProcessorContainer({ script: scriptedRuntime(happyTurnScript()) });
    const { chat, turn } = await seedChatWithTurn(container);
    const creating = await container.repos.workspaces.create({
      kind: 'CHAT',
      chatId: chat.id,
      runnerKind: 'fake',
      image: 'image',
      repoUrl: FIXTURE_REPO_URL,
      branch: 'main',
    });

    await runTurnOn(container, turn.id);

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
    const container = setupProcessorContainer({ script: scriptedRuntime(happyTurnScript()) });
    const { chat, turn } = await seedChatWithTurn(container);
    const stale = await container.repos.workspaces.create({
      kind: 'CHAT',
      chatId: chat.id,
      runnerKind: 'fake',
      image: 'image',
      repoUrl: FIXTURE_REPO_URL,
      branch: 'main',
    });
    await container.repos.workspaces.setStatus(stale.id, 'READY', { runnerRef: 'ref-1' });
    vi.spyOn(container.runner, 'destroy').mockRejectedValueOnce(new Error('daemon busy'));

    await runTurnOn(container, turn.id, 1);

    expect(await container.repos.workspaces.get(stale.id)).toMatchObject({ status: 'DESTROYED' });
    expect(container.logs.join('')).toContain('destroying a stalled workspace failed');
    expect((await container.repos.turns.get(turn.id))?.status).toBe('SUCCEEDED');
    vi.restoreAllMocks();
  });

  /**
   * A workspace the recovery destroyed takes the model's filesystem with it, and the note saying
   * so is a message like any other — which means it only reaches the model if the history is read
   * after the recovery wrote it.
   */
  it('hands the model the note saying its previous filesystem is gone', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyTurnScript()) });
    const { chat, turn } = await seedChatWithTurn(container);
    const stalled = await container.repos.workspaces.create({
      kind: 'CHAT',
      chatId: chat.id,
      runnerKind: 'fake',
      image: 'image',
      repoUrl: FIXTURE_REPO_URL,
      branch: 'main',
    });
    await container.repos.workspaces.setStatus(stalled.id, 'READY', { runnerRef: 'ref-1' });
    await container.repos.workspaces.setStatus(stalled.id, 'BUSY');

    await runTurnOn(container, turn.id);

    const request = (await requestSentTo(container)) as { items: unknown[] };
    expect(JSON.stringify(request.items)).toContain(STALLED_RECOVERY_NOTE);
  });

  /**
   * The prompt and the request are two descriptions of one turn, and the agent obeys both. A
   * prompt naming the base branch as the place to push, next to a sentence forbidding a push
   * there, is an instruction the agent cannot follow.
   */
  it('names one work branch in the prompt and in the request', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyTurnScript()) });
    const { turn } = await seedChatWithTurn(container);

    await runTurnOn(container, turn.id);

    const request = (await requestSentTo(container)) as {
      instructions: string;
      repo: { workBranch: string; baseBranch: string };
    };
    expect(request.repo.workBranch).not.toBe(request.repo.baseBranch);
    expect(request.instructions).toContain(
      `push your work to the branch ${request.repo.workBranch}`,
    );
    expect(request.instructions).toContain(`to ${request.repo.baseBranch} and never force-push`);
  });
});

describe('createRunTurnProcessor, two turns of one chat', () => {
  /**
   * A chat has one workspace and its turns share it. A second turn delivered while the first is
   * executing must not take it: the two would write the same filesystem, and the second would
   * reach it through the stalled recovery, which destroys the container the first is running in.
   * The second turn is refused instead, and the first finishes in the workspace it owns.
   */
  it('refuses a second turn while the first holds the workspace', async () => {
    const container = setupProcessorContainer({ script: heldTurnScript() });
    const { chat, turn } = await seedChatWithTurn(container);
    const second = await container.repos.turns.create({ chatId: chat.id, model: 'test-model' });
    const busy = whenWorkspaceIsBusy(container);

    const first = runTurnOn(container, turn.id);
    await busy;
    await runTurnOn(container, second.id);

    const refused = await container.repos.turns.get(second.id);
    expect(refused?.status).toBe('FAILED');
    expect(refused?.error).toContain(WORKSPACE_CONFLICT_CODE);
    expect(container.publisher.eventsFor(second.id).at(-1)).toMatchObject({ type: 'turn.failed' });
    expect([...container.repos.store.workspaces.values()]).toHaveLength(1);
    expect(container.runner.calls.filter((call) => call.method === 'exec')).toHaveLength(1);

    container.commands.emitCancel(turn.id);
    await first;
    expect((await container.repos.turns.get(turn.id))?.status).toBe('CANCELLED');
  });
});

describe('createRunTurnProcessor, listening for a cancellation', () => {
  /**
   * The web app answers a cancellation it could not apply itself — the job was already handed to a
   * worker — by publishing on the turn's channel, and pub/sub keeps nothing for a subscriber that
   * has not arrived yet. Every row read before subscribing is time in which that request reaches
   * nobody while the caller has been told the worker will act on it, so the subscription is taken
   * before the first read rather than after.
   */
  it('subscribes to the cancellation channel before reading any row', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyTurnScript()) });
    const { turn } = await seedChatWithTurn(container);
    const subscriptionsAtFirstRead: number[] = [];
    const get = container.repos.turns.get.bind(container.repos.turns);
    vi.spyOn(container.repos.turns, 'get').mockImplementation(async (id) => {
      subscriptionsAtFirstRead.push(container.commands.subscriptions);
      return get(id);
    });

    await runTurnOn(container, turn.id);

    expect(subscriptionsAtFirstRead.at(0)).toBe(1);
    expect(container.commands.subscriptions).toBe(0);
    vi.restoreAllMocks();
  });
});

describe('createRunTurnProcessor, one job delivered twice', () => {
  /**
   * Stalled-job recovery can deliver a job again while the first delivery is still executing it
   * here. The second copy is not a competing turn — it is the same turn — so it must leave the
   * execution alone: failing it as a workspace conflict would terminalise the row and end the
   * stream of a turn that is still running and still writing to both.
   */
  it('leaves the running turn alone when its own job is redelivered', async () => {
    const container = setupProcessorContainer({ script: heldTurnScript() });
    const { turn } = await seedChatWithTurn(container);
    const busy = whenWorkspaceIsBusy(container);

    const first = runTurnOn(container, turn.id);
    await busy;
    await runTurnOn(container, turn.id, 1);

    const during = await container.repos.turns.get(turn.id);
    expect(during === null ? true : isTerminalRunStatus(during.status)).toBe(false);
    expect(during?.error).toBeNull();
    expect(
      container.publisher.eventsFor(turn.id).some((event) => event.type === 'turn.failed'),
    ).toBe(false);
    expect(container.logs.join('')).toContain('this turn is already running here');
    expect(container.runner.calls.filter((call) => call.method === 'exec')).toHaveLength(1);

    container.commands.emitCancel(turn.id);
    await first;
    expect((await container.repos.turns.get(turn.id))?.status).toBe('CANCELLED');
  });
});
