/**
 * Unit tests for the workspace collector.
 *
 * Layer: unit.
 * Goal: only idle `READY` workspaces are reclaimed, a container this instance owns with no live
 * row is destroyed, a live row whose container is gone is closed out unless somebody owns it,
 * another instance's containers are never touched, and the archive job tears down the one
 * workspace of its chat. Every write is checked against the row as it is at the moment of the
 * write, not as the pass's opening snapshot described it.
 * Mocks: `createTestContainer` with a `FakeClock`.
 */
import { JOB_NAMES } from '@agent-hangar/core';
import type { Workspace } from '@agent-hangar/core';
import { FakeClock } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { chatClaimKey } from '../claims.js';
import {
  createTestContainer,
  FIXTURE_REPO_URL,
  heldTurnScript,
  runTurnOn,
  seedChatWithTurn,
  setupProcessorContainer,
  whenWorkspaceIsBusy,
} from '../testing/index.js';
import type { TestContainer } from '../testing/index.js';

import { CONTAINER_MISSING_REASON, createGcProcessor } from './gc.js';
import type { GcResult } from './gc.js';
import type { ProcessorJob } from './types.js';

const REPO_URL = 'https://github.com/octocat/Hello-World';

/** Runs the collector over a job. */
async function collect(
  container: TestContainer,
  name: string,
  data: unknown = {},
): Promise<GcResult> {
  const job: ProcessorJob<unknown> = { id: 'gc-1', name, data, attemptsMade: 0 };
  return createGcProcessor(container)(job);
}

/** Seeds a chat with a live workspace, optionally backed by a real fake container. */
async function seedWorkspace(
  container: TestContainer,
  options: { status: 'READY' | 'BUSY'; idleMinutes: number; withContainer?: boolean },
): Promise<Workspace> {
  const chat = await container.repos.chats.create({
    title: 'Task',
    repoUrl: REPO_URL,
    baseBranch: 'main',
  });
  const created = await container.repos.workspaces.create({
    kind: 'CHAT',
    chatId: chat.id,
    runnerKind: 'fake',
    image: 'image',
    repoUrl: REPO_URL,
    branch: 'main',
  });
  await container.repos.workspaces.setStatus(created.id, 'READY', { runnerRef: 'ref-1' });
  if (options.status === 'BUSY') {
    await container.repos.workspaces.setStatus(created.id, 'BUSY');
  }
  if (options.withContainer === true) {
    await container.runner.create({
      workspaceId: created.id,
      kind: 'CHAT',
      image: 'image',
      env: {},
      limits: { cpus: 1, memoryBytes: 1, pids: 1 },
      labels: { 'ah.instance': container.config.AH_INSTANCE },
    });
  }
  const row = container.repos.store.workspaces.get(created.id);
  if (row !== undefined) {
    row.lastActiveAt = new Date(container.clock.now().getTime() - options.idleMinutes * 60_000);
  }
  return created;
}

describe('createGcProcessor', () => {
  /**
   * Only `READY` workspaces past the TTL are reclaimed: a fresh one is still in use, and a `BUSY`
   * one is running a turn.
   */
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
    expect(container.logs.join('')).toContain('orphan workspace destroyed');
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
    expect(container.logs.join('')).toContain('destroying an orphan workspace failed');
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
    expect(await container.repos.workspaces.get(ready.id)).toMatchObject({
      status: 'DESTROYED',
      failureReason: CONTAINER_MISSING_REASON,
    });
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

    expect(result).toEqual({ reaped: 0, orphansDestroyed: 0, goneMarked: 0 });
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('BUSY');
    expect(container.runner.getWorkspace(workspace.id)?.status).toBe('running');
    expect(container.logs.join('')).toContain('left for the idle collector');
  });

  /**
   * Archiving a chat that has no live workspace is a no-op, which is what a double archive is.
   */
  it('does nothing for an archived chat with no workspace', async () => {
    const container = createTestContainer();
    const chat = await container.repos.chats.create({
      title: 'Task',
      repoUrl: REPO_URL,
      baseBranch: 'main',
    });

    const result = await collect(container, JOB_NAMES.destroyChatWorkspace, { chatId: chat.id });

    expect(result).toEqual({ reaped: 0, orphansDestroyed: 0, goneMarked: 0 });
    expect(container.logs.join('')).toContain('chat had no live workspace');
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
    expect(container.logs.join('')).toContain('destroying an orphan workspace failed');
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
      repoUrl: REPO_URL,
      baseBranch: 'main',
    });
    const creating = await container.repos.workspaces.create({
      kind: 'CHAT',
      chatId: chat.id,
      runnerKind: 'fake',
      image: 'image',
      repoUrl: REPO_URL,
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
    expect(container.logs.join('')).toContain('moved on since the listing');
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
    expect(container.logs.join('')).toContain('left for the next pass');
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
    const busy = whenWorkspaceIsBusy(container);
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
    await seedWorkspace(container, { status: 'READY', idleMinutes: 120, withContainer: true });
    vi.spyOn(container.repos.workspaces, 'get').mockResolvedValue(null);

    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(result.reaped).toBe(0);
    expect(container.logs.join('')).toContain('no longer idle');
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

    expect(result).toEqual({ reaped: 0, orphansDestroyed: 0, goneMarked: 0 });
    expect(container.logs.join('')).toContain('unknown workspace-gc job');
  });
});
