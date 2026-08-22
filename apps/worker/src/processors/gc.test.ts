/**
 * Unit tests for the workspace collector.
 *
 * Layer: unit.
 * Goal: only idle `READY` workspaces are reclaimed, a container this instance owns with no live
 * row is destroyed, a live row whose container is gone is closed out unless somebody owns it,
 * another instance's containers are never touched, and the archive job tears down the one
 * workspace of its chat. Every write is checked against the row as it is at the moment of the
 * write, not as the pass's opening snapshot described it, and a teardown that abandoned its row is
 * finished on its behalf. The recovery a boot performs has its own file.
 * Mocks: `createTestContainer` with a `FakeClock`.
 */
import { JOB_NAMES } from '@agent-hangar/core';
import { FakeClock } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { chatClaimKey, workspaceClaimKey } from '../claims.js';
import {
  collect,
  createTestContainer,
  FIXTURE_REPO_URL,
  GC_FIXTURE_REPO_URL,
  heldTurnScript,
  runTurnOn,
  seedChatWithTurn,
  seedWorkspace,
  setupProcessorContainer,
  whenTurnIsExecuting,
} from '../testing/index.js';

import { ABANDONED_TEARDOWN_REASON, CONTAINER_MISSING_REASON } from './gc.js';

/** The records the container collected, parsed back from the lines pino wrote. */
function records(logs: string[]): Record<string, unknown>[] {
  return logs.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('createGcProcessor', () => {
  /**
   * Only `READY` workspaces past the TTL are reclaimed: a fresh one is still in use, and a `BUSY`
   * one is running a turn.
   */
  it('never considers a workspace the idle selection did not pick', async () => {
    const container = createTestContainer({ clock: new FakeClock() });
    const fresh = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 0,
      withContainer: true,
    });

    const result = await collect(container, JOB_NAMES.reapIdle);

    // The selection is what decides, and it decides once, from the listing. A pass that handed
    // every live row to the reclaim would re-read each of them and report each as "no longer idle"
    // — a line per workspace per tick, saying nothing, about work that was never selected.
    expect(result.reaped).toBe(0);
    expect((await container.repos.workspaces.get(fresh.id))?.status).toBe('READY');
    expect(container.logs.join('')).not.toContain('no longer idle');
  });

  /**
   * The label sweep of a chat's containers is scoped to that chat as well as to this instance. A
   * sweep by instance alone would find every container this worker owns and destroy all of them
   * because one chat was deleted.
   */
  it('destroys only the deleted chat’s containers, not the instance’s', async () => {
    const container = createTestContainer();
    const limits = { cpus: 1, memoryBytes: 1, pids: 1 };
    await container.runner.create({
      workspaceId: 'ws-deleted-chat',
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits,
      labels: { 'ah.instance': container.config.AH_INSTANCE, 'ah.chat': 'chat-that-went' },
    });
    await container.runner.create({
      workspaceId: 'ws-other-chat',
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits,
      labels: { 'ah.instance': container.config.AH_INSTANCE, 'ah.chat': 'chat-still-here' },
    });

    const result = await collect(container, JOB_NAMES.destroyChatWorkspace, {
      chatId: 'chat-that-went',
    });

    expect(result.orphansDestroyed).toBe(1);
    expect(container.runner.getWorkspace('ws-deleted-chat')?.status).toBe('gone');
    expect(container.runner.getWorkspace('ws-other-chat')?.status).toBe('running');
  });

  it('leaves an idle workspace whose claim is already held, naming it', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 120,
      withContainer: true,
    });
    container.claims.claim(workspaceClaimKey(workspace));

    const result = await collect(container, JOB_NAMES.reapIdle);

    // A claim held by something else is a turn about to run in this container: reclaiming it would
    // pull the filesystem out from under work that has already started.
    expect(result.reaped).toBe(0);
    expect(container.runner.getWorkspace(workspace.id)?.status).toBe('running');
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'workspace is in use; left for the next pass',
        workspaceId: workspace.id,
      }),
    );
  });

  /**
   * The note the model is left with says the workspace went because it sat idle, and for how long.
   * An idle reclaim and an archive are different events to the person reading the transcript, and
   * a teardown told neither would describe one as the other.
   */
  it('tells the chat its workspace went for being idle, and for how long', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 120,
      withContainer: true,
    });
    const chatId = workspace.chatId ?? '';

    expect((await collect(container, JOB_NAMES.reapIdle)).reaped).toBe(1);

    const messages = await container.repos.messages.listByChat(chatId);
    expect(messages.at(-1)?.content).toBe(
      `Workspace reclaimed after ${String(container.config.WORKSPACE_IDLE_TTL_MIN)} min idle; ` +
        'no uncommitted changes. It will be recreated from history on the next message.',
    );
  });

  it('reclaims only idle ready workspaces', async () => {
    const container = createTestContainer({ clock: new FakeClock() });
    const old = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 120,
      withContainer: true,
    });
    const fresh = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 1,
      withContainer: true,
    });
    const busy = await seedWorkspace(container, {
      status: 'BUSY',
      idleMinutes: 120,
      withContainer: true,
    });

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result.reaped).toBe(1);
    expect((await container.repos.workspaces.get(old.id))?.status).toBe('DESTROYED');
    expect((await container.repos.workspaces.get(fresh.id))?.status).toBe('READY');
    expect((await container.repos.workspaces.get(busy.id))?.status).toBe('BUSY');
    expect(container.logs.join('')).toContain('workspace collection finished');
  });

  /**
   * A workspace whose teardown failed is not counted as reclaimed, and the pass keeps going.
   */
  it('does not count a workspace whose teardown failed', async () => {
    const container = createTestContainer();
    await seedWorkspace(container, { status: 'READY', idleMinutes: 120, withContainer: true });
    vi.spyOn(container.runner, 'destroy').mockRejectedValue(new Error('remove refused'));

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result.reaped).toBe(0);
    vi.restoreAllMocks();
  });

  /**
   * A container this instance owns that no live row points at is a leak from an interrupted
   * create; another instance's container is not this collector's business.
   */
  it('destroys an orphan of this instance and leaves other instances alone', async () => {
    const container = createTestContainer();
    const limits = { cpus: 1, memoryBytes: 1, pids: 1 };
    await container.runner.create({
      workspaceId: 'orphan-1',
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits,
      labels: { 'ah.instance': container.config.AH_INSTANCE },
    });
    await container.runner.create({
      workspaceId: 'other-instance',
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits,
      labels: { 'ah.instance': 'somebody-else' },
    });

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result.orphansDestroyed).toBe(1);
    expect(container.runner.getWorkspace('orphan-1')?.status).toBe('gone');
    expect(container.runner.getWorkspace('other-instance')?.status).toBe('running');
    // Which container was removed. An operator reading "an orphan was destroyed" and nothing else
    // cannot tell whether the collector took the container they were about to look at.
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({ msg: 'orphan workspace destroyed', workspaceId: 'orphan-1' }),
    );
  });

  /**
   * An orphan the daemon refuses to remove is reported and not counted; the next pass tries again.
   */
  it('reports an orphan it could not destroy', async () => {
    const container = createTestContainer();
    await container.runner.create({
      workspaceId: 'orphan-1',
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits: { cpus: 1, memoryBytes: 1, pids: 1 },
      labels: { 'ah.instance': container.config.AH_INSTANCE },
    });
    vi.spyOn(container.runner, 'destroy').mockRejectedValue(new Error('remove refused'));

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result.orphansDestroyed).toBe(0);
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'destroying an orphan workspace failed',
        workspaceId: 'orphan-1',
        err: expect.objectContaining({ message: 'remove refused' }) as unknown,
      }),
    );
    vi.restoreAllMocks();
  });

  /**
   * A live row whose container is gone is closed out — unless a turn is running against it, in
   * which case the turn processor's stalled recovery owns the case and writes the note that goes
   * with it.
   */
  it('closes out rows whose container is gone, except busy ones', async () => {
    const container = createTestContainer();
    const ready = await seedWorkspace(container, { status: 'READY', idleMinutes: 1 });
    const busy = await seedWorkspace(container, { status: 'BUSY', idleMinutes: 1 });

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result.goneMarked).toBe(1);
    // The reason is written out as well as read from the export: it is what an operator finds on
    // the row, and compared only against the constant it came from it could be emptied unnoticed.
    expect(await container.repos.workspaces.get(ready.id)).toMatchObject({
      status: 'DESTROYED',
      failureReason: 'container missing',
    });
    expect(CONTAINER_MISSING_REASON).toBe('container missing');
    expect((await container.repos.workspaces.get(busy.id))?.status).toBe('BUSY');
  });

  /**
   * Archiving a chat tears its workspace down straight away rather than waiting for the TTL.
   */
  it('tears down the workspace of an archived chat', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 0,
      withContainer: true,
    });
    const chatId = workspace.chatId ?? '';

    const result = await collect(container, JOB_NAMES.destroyChatWorkspace, { chatId });

    expect(result.reaped).toBe(1);
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('DESTROYED');
    const messages = await container.repos.messages.listByChat(chatId);
    expect(messages.at(-1)?.content).toContain('Workspace archived');
  });

  /**
   * An archive whose container the daemon refuses to remove is not counted as reclaimed; the row
   * is left `FAILED` for the next reconciliation to close out.
   */
  it('does not count an archive teardown that failed', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 0,
      withContainer: true,
    });
    vi.spyOn(container.runner, 'destroy').mockRejectedValue(new Error('remove refused'));

    const result = await collect(container, JOB_NAMES.destroyChatWorkspace, {
      chatId: workspace.chatId ?? '',
    });

    expect(result.reaped).toBe(0);
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('FAILED');
    vi.restoreAllMocks();
  });

  /**
   * An archive can arrive while a turn of that chat is still executing. Removing the container
   * then fails a turn the user is watching, and the archive loses nothing by waiting: the chat
   * takes no further turn, so the workspace falls idle and a later pass reaps it.
   */
  it('leaves an archived chat workspace a turn is holding to the idle collector', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'BUSY',
      idleMinutes: 0,
      withContainer: true,
    });
    const chatId = workspace.chatId ?? '';
    container.claims.claim(chatClaimKey(chatId));

    const result = await collect(container, JOB_NAMES.destroyChatWorkspace, { chatId });

    expect(result).toEqual({ reaped: 0, orphansDestroyed: 0, goneMarked: 0, teardownsFinished: 0 });
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('BUSY');
    expect(container.runner.getWorkspace(workspace.id)?.status).toBe('running');
    // The chat is on the line. The archive was asked for by a chat, and that is the identifier the
    // operator has; the workspace it maps to is not something they are holding.
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({ msg: 'workspace is in use; left for the idle collector', chatId }),
    );
  });

  /**
   * The cross-process case, and the one the in-process register cannot answer: no claim is held
   * here, so the archive reaches the teardown exactly as a second worker's archive would. It must
   * still leave the container standing, because the row itself says a turn owns it.
   */
  it('leaves an archived chat workspace a turn owns alone with no claim held', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'BUSY',
      idleMinutes: 0,
      withContainer: true,
    });
    const chatId = workspace.chatId ?? '';

    const result = await collect(container, JOB_NAMES.destroyChatWorkspace, { chatId });

    expect(result).toEqual({ reaped: 0, orphansDestroyed: 0, goneMarked: 0, teardownsFinished: 0 });
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('BUSY');
    expect(container.runner.getWorkspace(workspace.id)?.status).toBe('running');
    expect(await container.repos.messages.listByChat(chatId)).toHaveLength(0);
  });

  /**
   * Archiving a chat that has no live workspace is a no-op, which is what a double archive is.
   */
  it('does nothing for an archived chat with no workspace', async () => {
    const container = createTestContainer();
    const chat = await container.repos.chats.create({
      title: 'Task',
      repoUrl: GC_FIXTURE_REPO_URL,
      baseBranch: 'main',
    });

    const result = await collect(container, JOB_NAMES.destroyChatWorkspace, { chatId: chat.id });

    expect(result).toEqual({ reaped: 0, orphansDestroyed: 0, goneMarked: 0, teardownsFinished: 0 });
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({ msg: 'chat had no live workspace', chatId: chat.id }),
    );
  });

  /**
   * A delivery naming a workspace whose row is gone falls back to the label sweep, exactly as one
   * naming no workspace does. The row is the only thing that has vanished — a container created
   * under that chat's label may well still be running — and a lookup that treated a missing row as
   * a live one would reach for a status that is not there.
   */
  it('falls back to the label when the workspace it names is gone', async () => {
    const container = createTestContainer();
    const chatId = 'chat-whose-row-went';
    await container.runner.create({
      workspaceId: 'ws-orphan',
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits: { cpus: 1, memoryBytes: 1, pids: 1 },
      labels: { 'ah.instance': container.config.AH_INSTANCE, 'ah.chat': chatId },
    });

    const result = await collect(container, JOB_NAMES.destroyChatWorkspace, {
      chatId,
      workspaceId: 'workspace-row-that-was-deleted',
    });

    expect(result.orphansDestroyed).toBe(1);
    expect(container.runner.getWorkspace('ws-orphan')?.status).toBe('gone');
  });

  /**
   * A delete names the workspace, because the chat id stops naming it: Postgres nulls
   * `Workspace.chatId` as the chat goes, one step before this job runs. The row is found by the id
   * the delivery carries and torn down properly, which is what leaves it recorded as destroyed
   * rather than merely container-less.
   */
  it('tears down the workspace a delivery names, after the chat is gone', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 0,
      withContainer: true,
    });
    const chatId = workspace.chatId ?? '';
    // What the chat's delete does to the row before the teardown ever sees it.
    await container.repos.chats.deleteIfIdle(chatId);

    const result = await collect(container, JOB_NAMES.destroyChatWorkspace, {
      chatId,
      workspaceId: workspace.id,
    });

    expect(result.reaped).toBe(1);
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('DESTROYED');
    expect(container.runner.getWorkspace(workspace.id)?.status).toBe('gone');
    expect(await container.repos.workspaces.listLive()).toHaveLength(0);
  });

  /**
   * A delivery whose workspace has already been closed out — a second delete of the same chat, or
   * a collection pass that got there first — finds no live row and falls back to the containers
   * the chat's label still names.
   */
  it('falls back to the label when the workspace it names is no longer live', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, { status: 'READY', idleMinutes: 0 });
    const chatId = workspace.chatId ?? '';
    await container.runner.create({
      workspaceId: workspace.id,
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits: { cpus: 1, memoryBytes: 1, pids: 1 },
      labels: { 'ah.instance': container.config.AH_INSTANCE, 'ah.chat': chatId },
    });
    await container.repos.workspaces.setStatus(workspace.id, 'DESTROYED');

    const result = await collect(container, JOB_NAMES.destroyChatWorkspace, {
      chatId,
      workspaceId: workspace.id,
    });

    expect(result.reaped).toBe(0);
    expect(result.orphansDestroyed).toBe(1);
    expect(container.runner.getWorkspace(workspace.id)?.status).toBe('gone');
  });

  /**
   * Deleting a chat cascades its workspace row's reference away before the teardown runs, so the
   * container is only reachable by the label it was created with — and it must still go.
   */
  it('destroys the container of a chat whose row is gone', async () => {
    const container = createTestContainer();
    const chatId = 'deleted-chat';
    await container.runner.create({
      workspaceId: 'ws-orphan',
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits: { cpus: 1, memoryBytes: 1, pids: 1 },
      labels: { 'ah.instance': container.config.AH_INSTANCE, 'ah.chat': chatId },
    });

    const result = await collect(container, JOB_NAMES.destroyChatWorkspace, { chatId });

    expect(result.orphansDestroyed).toBe(1);
    expect(container.runner.getWorkspace('ws-orphan')?.status).toBe('gone');
    // Both identifiers: the chat the delivery named, and the container that was found under its
    // label with no row left pointing at it.
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'orphan workspace destroyed',
        chatId,
        workspaceId: 'ws-orphan',
      }),
    );
  });

  /**
   * A container the daemon refuses to remove is reported and not counted; the idle pass reaps it
   * by the instance label on its next tick.
   */
  it('reports a chat container it could not destroy', async () => {
    const container = createTestContainer();
    const chatId = 'deleted-chat';
    await container.runner.create({
      workspaceId: 'ws-orphan',
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits: { cpus: 1, memoryBytes: 1, pids: 1 },
      labels: { 'ah.instance': container.config.AH_INSTANCE, 'ah.chat': chatId },
    });
    vi.spyOn(container.runner, 'destroy').mockRejectedValue(new Error('remove refused'));

    const result = await collect(container, JOB_NAMES.destroyChatWorkspace, { chatId });

    expect(result.orphansDestroyed).toBe(0);
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'destroying an orphan workspace failed',
        workspaceId: 'ws-orphan',
        err: expect.objectContaining({ message: 'remove refused' }) as unknown,
      }),
    );
    vi.restoreAllMocks();
  });

  /**
   * A workspace that is still being created has no container to list yet. Closing its row out on
   * that evidence marks an active creation `DESTROYED`, and the create that is still running then
   * either orphans its container or writes over a terminal row.
   */
  it('leaves a workspace that is still being created alone', async () => {
    const container = createTestContainer();
    const chat = await container.repos.chats.create({
      title: 'Task',
      repoUrl: GC_FIXTURE_REPO_URL,
      baseBranch: 'main',
    });
    const creating = await container.repos.workspaces.create({
      kind: 'CHAT',
      chatId: chat.id,
      runnerKind: 'fake',
      image: 'image',
      repoUrl: GC_FIXTURE_REPO_URL,
      branch: 'main',
    });

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result.goneMarked).toBe(0);
    expect((await container.repos.workspaces.get(creating.id))?.status).toBe('CREATING');
  });

  /**
   * A teardown writes `STOPPING` and then finishes the row itself, so a `STOPPING` row a pass can
   * see belongs to a teardown that died. Nothing else will ever close it out, so this pass must.
   */
  it('closes out a stopping row whose teardown never finished', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, { status: 'READY', idleMinutes: 1 });
    await container.repos.workspaces.setStatus(workspace.id, 'STOPPING');

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result.goneMarked).toBe(1);
    expect(await container.repos.workspaces.get(workspace.id)).toMatchObject({
      status: 'DESTROYED',
      failureReason: CONTAINER_MISSING_REASON,
    });
  });

  /**
   * A teardown that lost its process after committing to `STOPPING`, but before its container was
   * gone, is the one live row nothing else can take: a teardown refuses it because it is not
   * `READY`, the idle selection refuses it for the same reason, and the reconciliation above
   * refuses it because its container is still listed and so is not missing. The pass finishes what
   * its owner had already decided to do, and the container really goes.
   */
  it('destroys the container of a teardown that never came back for it', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 1,
      withContainer: true,
    });
    await container.repos.workspaces.setStatus(workspace.id, 'STOPPING');
    const recordedRef = (await container.repos.workspaces.get(workspace.id))?.runnerRef;

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(recordedRef).toEqual(expect.any(String));
    expect(container.runner.getWorkspace(workspace.id)?.status).toBe('gone');
    expect(result.teardownsFinished).toBe(1);
    // Written out as well as read from the export: this is the sentence on the row that tells an
    // operator the container went because nobody came back for it, not because it failed.
    expect(await container.repos.workspaces.get(workspace.id)).toMatchObject({
      status: 'DESTROYED',
      failureReason: 'teardown abandoned',
    });
    expect(ABANDONED_TEARDOWN_REASON).toBe('teardown abandoned');
    // The daemon is asked about the reference the row recorded, not about some other container.
    expect(container.runner.calls).toContainEqual({
      method: 'destroy',
      args: [{ workspaceId: workspace.id, runnerRef: recordedRef }],
    });
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'finished a teardown whose process never came back for the container',
        workspaceId: workspace.id,
      }),
    );
  });

  /**
   * A container the daemon still refuses to remove leaves a row that would otherwise stay live for
   * ever, so the failure is recorded on the row and the container becomes an orphan the next pass
   * keeps trying. What must not happen is a second live row nobody can take.
   */
  it('records the failure when an abandoned teardown cannot be finished', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 1,
      withContainer: true,
    });
    await container.repos.workspaces.setStatus(workspace.id, 'STOPPING');
    vi.spyOn(container.runner, 'destroy').mockRejectedValue(new Error('daemon is busy'));

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result.teardownsFinished).toBe(0);
    expect(await container.repos.workspaces.get(workspace.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'daemon is busy',
    });
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'finishing an abandoned teardown failed',
        workspaceId: workspace.id,
        err: expect.objectContaining({ message: 'daemon is busy' }) as unknown,
      }),
    );
  });

  /**
   * A `STOPPING` row whose reference was never written still has a container the label sweep can
   * see, and a runner that rejects with something that is not an `Error` still has to leave a
   * readable reason on the row rather than `[object Object]`.
   */
  it('records a non-Error refusal for a stopping row with no runner reference', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 1,
      withContainer: true,
    });
    const row = container.repos.store.workspaces.get(workspace.id);
    if (row !== undefined) {
      row.runnerRef = null;
    }
    await container.repos.workspaces.setStatus(workspace.id, 'STOPPING');
    vi.spyOn(container.runner, 'destroy').mockRejectedValue('daemon said no');

    const destroy = vi.spyOn(container.runner, 'destroy');
    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result.teardownsFinished).toBe(0);
    expect(await container.repos.workspaces.get(workspace.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'daemon said no',
    });
    // Empty rather than invented: there is no reference on the row to give, and any value put here
    // would send the daemon looking for a container this row never recorded.
    expect(destroy.mock.calls[0]).toStrictEqual([{ workspaceId: workspace.id, runnerRef: '' }]);
  });

  /**
   * A teardown of this process holds its workspace's claim for the whole sequence, so a claim this
   * pass cannot take is a container somebody is in the middle of destroying. Taking it anyway would
   * make the pass race the owner it exists to stand in for.
   */
  it('leaves a stopping row whose teardown is still running', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 1,
      withContainer: true,
    });
    await container.repos.workspaces.setStatus(workspace.id, 'STOPPING');
    const row = await container.repos.workspaces.get(workspace.id);
    expect(container.claims.claim(workspaceClaimKey(row ?? workspace))).toBe(true);

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result.teardownsFinished).toBe(0);
    expect(container.runner.getWorkspace(workspace.id)?.status).toBe('running');
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('STOPPING');
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'a teardown is still running; its workspace is left for the next pass',
        workspaceId: workspace.id,
      }),
    );
  });

  /**
   * Every pass gives the claim back, whatever it did with the workspace. The collector runs on a
   * schedule against the same rows, so a claim kept after a pass is a workspace this worker can
   * never touch again — the container stays until the process is restarted, and the log says only
   * that something is in use. Each of the four passes is driven twice here, the first time into a
   * failure that leaves the row exactly where it was.
   */
  it('gives every claim back, so the next pass can take the same workspace', async () => {
    const container = createTestContainer();
    const idle = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 120,
      withContainer: true,
    });
    const destroy = vi
      .spyOn(container.runner, 'destroy')
      .mockRejectedValueOnce(new Error('daemon is busy'));

    // First pass: the teardown fails, the row is left FAILED — nothing here released by accident.
    expect((await collect(container, JOB_NAMES.reapIdle)).reaped).toBe(0);
    destroy.mockRestore();
    // Put the row back the way the failed pass found it, which is what a retry of the daemon call
    // would have left, and run the collector again over the very same workspace.
    const row = container.repos.store.workspaces.get(idle.id);
    if (row !== undefined) {
      row.status = 'READY';
    }

    expect((await collect(container, JOB_NAMES.reapIdle)).reaped).toBe(1);
    expect(container.logs.join('')).not.toContain('workspace is in use');
  });

  /**
   * The same for the archive path, which is delivered by BullMQ and therefore retried: a claim
   * held past a failed delivery would make every retry of it report the workspace as in use.
   */
  it('gives the archive claim back, so a redelivery can take the same workspace', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 0,
      withContainer: true,
    });
    const chatId = workspace.chatId ?? '';
    const destroy = vi
      .spyOn(container.runner, 'destroy')
      .mockRejectedValueOnce(new Error('daemon is busy'));

    expect((await collect(container, JOB_NAMES.destroyChatWorkspace, { chatId })).reaped).toBe(0);
    destroy.mockRestore();
    const row = container.repos.store.workspaces.get(workspace.id);
    if (row !== undefined) {
      row.status = 'READY';
    }

    expect((await collect(container, JOB_NAMES.destroyChatWorkspace, { chatId })).reaped).toBe(1);
    expect(container.logs.join('')).not.toContain('left for the idle collector');
  });

  /**
   * And for the two reconciliation passes, whose rows are found by the same claim key: a pass that
   * closed out a gone row, or finished an abandoned teardown, must leave the key free for whatever
   * comes next — including the teardown that is about to be created for the same chat.
   */
  it('gives the reconciliation claims back', async () => {
    const container = createTestContainer();
    const gone = await seedWorkspace(container, { status: 'READY', idleMinutes: 1 });
    const stopping = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 1,
      withContainer: true,
    });
    await container.repos.workspaces.setStatus(stopping.id, 'STOPPING');

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result).toMatchObject({ goneMarked: 1, teardownsFinished: 1 });
    expect(container.claims.claim(workspaceClaimKey(gone))).toBe(true);
    expect(container.claims.claim(workspaceClaimKey(stopping))).toBe(true);
  });

  /**
   * The rows this pass closes out were listed before the runner was asked what it still holds, and
   * a turn can take one in between. The close-out names the status the listing reported, so the
   * row a turn took is left holding what that turn wrote instead of being marked `DESTROYED` under
   * it — which is the arbitration a second worker process needs and an in-process register cannot
   * give.
   */
  it('leaves a row another writer took between the listing and the write', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, { status: 'READY', idleMinutes: 1 });
    const list = container.runner.list.bind(container.runner);
    vi.spyOn(container.runner, 'list').mockImplementation(async (labels) => {
      const handles = await list(labels);
      await container.repos.workspaces.setStatus(workspace.id, 'BUSY');
      return handles;
    });

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result.goneMarked).toBe(0);
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('BUSY');
    // The status the listing reported is on the line beside the row: that is what the write was
    // conditioned on, and without it nobody can tell a row that moved from one that never existed.
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'workspace moved on since the listing; left for the next pass',
        workspaceId: workspace.id,
        expectedStatus: 'READY',
      }),
    );
    vi.restoreAllMocks();
  });

  /**
   * A row whose container is missing may be a row somebody is working on right now — the create
   * that has not registered its container yet, or a turn between two writes. The collector writes
   * only to rows it can claim, and leaves the rest for the pass after.
   */
  it('leaves a claimed row whose container is gone for the next pass', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, { status: 'READY', idleMinutes: 1 });
    container.claims.claim(chatClaimKey(workspace.chatId ?? ''));

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result.goneMarked).toBe(0);
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('READY');
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'workspace is in use; left for the next pass',
        workspaceId: workspace.id,
      }),
    );
  });

  /**
   * The idle selection came from a listing taken at the start of the pass. A turn that claimed the
   * workspace since then is executing in the container this teardown would remove, so the teardown
   * asks for the claim and finds it taken.
   */
  it('leaves a workspace a turn claimed after the idle snapshot alone', async () => {
    const container = setupProcessorContainer({ script: heldTurnScript() });
    const { chat, turn } = await seedChatWithTurn(container);
    const workspace = await container.repos.workspaces.create({
      kind: 'CHAT',
      chatId: chat.id,
      runnerKind: 'fake',
      image: 'image',
      repoUrl: FIXTURE_REPO_URL,
      branch: 'main',
    });
    const handle = await container.runner.create({
      workspaceId: workspace.id,
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits: { cpus: 1, memoryBytes: 1, pids: 1 },
      labels: { 'ah.instance': container.config.AH_INSTANCE },
    });
    await container.repos.workspaces.setStatus(workspace.id, 'READY', {
      runnerRef: handle.runnerRef,
    });
    const busy = whenTurnIsExecuting(container);
    const stored = container.repos.store.workspaces.get(workspace.id);
    if (stored !== undefined) {
      stored.lastActiveAt = new Date(container.clock.now().getTime() - 120 * 60_000);
    }
    // The turn starts between the collector's snapshot and its teardown, which is the window the
    // teardown would otherwise act on stale information in.
    let running: Promise<void> | undefined;
    const listLive = container.repos.workspaces.listLive.bind(container.repos.workspaces);
    vi.spyOn(container.repos.workspaces, 'listLive').mockImplementation(async () => {
      const snapshot = await listLive();
      if (running === undefined) {
        running = runTurnOn(container, turn.id);
        await busy;
      }
      return snapshot;
    });

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result.reaped).toBe(0);
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('BUSY');
    expect(container.runner.getWorkspace(workspace.id)?.status).toBe('running');

    vi.restoreAllMocks();
    container.commands.emitCancel(turn.id);
    await running;
  });

  /**
   * A row that vanished between the snapshot and the teardown is nothing to tear down.
   */
  it('leaves an idle workspace whose row is gone', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 120,
      withContainer: true,
    });
    vi.spyOn(container.repos.workspaces, 'get').mockResolvedValue(null);

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result.reaped).toBe(0);
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'workspace is no longer idle; left alone',
        workspaceId: workspace.id,
      }),
    );
    vi.restoreAllMocks();
  });

  /**
   * A turn can take an idle workspace, use it and give it back inside one collection pass. The row
   * is `READY` again by the time the teardown runs, but it is not idle any more, and reclaiming it
   * would throw away a container the chat has just started using.
   */
  it('leaves an idle workspace a turn touched since the snapshot', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 120,
      withContainer: true,
    });
    const get = container.repos.workspaces.get.bind(container.repos.workspaces);
    vi.spyOn(container.repos.workspaces, 'get').mockImplementation(async (id) => {
      const row = await get(id);
      return row === null ? null : { ...row, lastActiveAt: container.clock.now() };
    });

    const result = await collect(container, JOB_NAMES.reapIdle);

    vi.restoreAllMocks();
    expect(result.reaped).toBe(0);
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('READY');
    expect(container.logs.join('')).toContain('no longer idle');
  });

  /**
   * A job name nobody registered is reported rather than crashing the consumer, which would take
   * the whole collector down with it.
   */
  it('reports an unknown job name', async () => {
    const container = createTestContainer();

    const result = await collect(container, 'compact-everything');

    expect(result).toEqual({ reaped: 0, orphansDestroyed: 0, goneMarked: 0, teardownsFinished: 0 });
    // The name is on the line. A collector that reported "an unknown job" without saying which one
    // leaves nobody able to find the producer that enqueued it.
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({ msg: 'unknown workspace-gc job', name: 'compact-everything' }),
    );
  });
});
