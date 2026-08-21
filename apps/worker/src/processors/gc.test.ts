/**
 * Unit tests for the workspace collector.
 *
 * Layer: unit.
 * Goal: only idle `READY` workspaces are reclaimed, a container this instance owns with no live
 * row is destroyed, a live row whose container is gone is closed out unless somebody owns it,
 * another instance's containers are never touched, and the archive job tears down the one
 * workspace of its chat. Every write is checked against the row as it is at the moment of the
 * write, not as the pass's opening snapshot described it. Boot recovery closes out the rows a
 * dead incarnation left `STOPPING` and leaves a teardown that is still in flight alone.
 * Mocks: `createTestContainer` with a `FakeClock`.
 */
import { JOB_NAMES } from '@agent-hangar/core';
import type { Workspace } from '@agent-hangar/core';
import { FakeClock } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { chatClaimKey, createWorkspaceClaims, workspaceClaimKey } from '../claims.js';
import {
  createTestContainer,
  FIXTURE_REPO_URL,
  heldTurnScript,
  runTurnOn,
  seedChatWithTurn,
  setupProcessorContainer,
  whenTurnIsExecuting,
} from '../testing/index.js';
import type { TestContainer } from '../testing/index.js';

import {
  ABANDONED_TEARDOWN_REASON,
  CONTAINER_MISSING_REASON,
  createGcProcessor,
  recoverAbandonedWorkspaces,
} from './gc.js';
import type { GcResult } from './gc.js';
import type { ProcessorJob } from './types.js';

const REPO_URL = 'https://github.com/octocat/Hello-World';

/** Runs the collector over a job. */
async function collect(
  container: TestContainer,
  name: string,
  data: unknown = {},
): Promise<GcResult> {
  const job: ProcessorJob<unknown> = { id: 'gc-1', name, data };
  return createGcProcessor(container)(job);
}

/** Seeds a `JOB` workspace and its container, in the state its run left it. */
async function seedJobWorkspace(container: TestContainer): Promise<Workspace> {
  const created = await container.repos.workspaces.create({
    kind: 'JOB',
    runnerKind: 'fake',
    image: 'image',
    repoUrl: REPO_URL,
    branch: 'main',
  });
  await container.repos.workspaces.setStatus(created.id, 'READY', { runnerRef: 'ref-1' });
  await container.runner.create({
    workspaceId: created.id,
    kind: 'JOB',
    image: 'image',
    env: {},
    limits: { cpus: 1, memoryBytes: 1, pids: 1 },
    labels: { 'ah.instance': container.config.AH_INSTANCE },
  });
  return created;
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

    expect(result).toEqual({ reaped: 0, orphansDestroyed: 0, goneMarked: 0 });
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
      repoUrl: REPO_URL,
      baseBranch: 'main',
    });

    const result = await collect(container, JOB_NAMES.destroyChatWorkspace, { chatId: chat.id });

    expect(result).toEqual({ reaped: 0, orphansDestroyed: 0, goneMarked: 0 });
    expect(container.logs.join('')).toContain('chat had no live workspace');
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

describe('recoverAbandonedWorkspaces', () => {
  /**
   * The state a teardown leaves when its process dies between claiming the row and destroying the
   * container: `STOPPING`, container still up. Nothing in the steady state reclaims it — a
   * teardown refuses anything that is not `READY`, the idle selection refuses it for the same
   * reason, and the reconciliation refuses it because the container is not gone. Boot is where
   * that is put right, and closing the row out is enough: the container stops belonging to a live
   * row, which is exactly what the orphan pass exists to clean up.
   */
  it('closes out a workspace whose teardown died, and the orphan pass destroys its container', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 0,
      withContainer: true,
    });
    await container.repos.workspaces.claimStatus(workspace.id, 'READY', 'STOPPING');

    const recovered = await recoverAbandonedWorkspaces(container);
    const result = await collect(container, JOB_NAMES.reapIdle);

    expect(recovered).toBe(1);
    expect(await container.repos.workspaces.get(workspace.id)).toMatchObject({
      status: 'DESTROYED',
      failureReason: ABANDONED_TEARDOWN_REASON,
    });
    expect(result.orphansDestroyed).toBe(1);
    expect(container.runner.getWorkspace(workspace.id)?.status).toBe('gone');
  });

  /**
   * The half a staleness rule would break. A teardown that is merely slow leaves a row that looks
   * identical to a dead one, so the recovery must never decide by how the row looks: it asks
   * whether anything here owns the workspace, and a teardown in flight holds exactly that claim.
   * The row and its container are left as they are.
   */
  it('leaves a teardown that is still in flight alone', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'READY',
      idleMinutes: 0,
      withContainer: true,
    });
    await container.repos.workspaces.claimStatus(workspace.id, 'READY', 'STOPPING');
    container.claims.claim(chatClaimKey(workspace.chatId ?? ''));

    const recovered = await recoverAbandonedWorkspaces(container);

    expect(recovered).toBe(0);
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('STOPPING');
    expect(container.runner.getWorkspace(workspace.id)?.status).toBe('running');
    expect(container.logs.join('')).toContain('still in flight');
  });

  /**
   * A teardown that finished between the listing and the write is not a row to close out, and the
   * conditional write is what says so — the same reason the reconciliation may name the status it
   * listed: the target is terminal, so the second caller matches nothing.
   */
  it('counts nothing for a row that reached its own terminal status first', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, { status: 'READY', idleMinutes: 0 });
    await container.repos.workspaces.claimStatus(workspace.id, 'READY', 'STOPPING');
    const listLive = container.repos.workspaces.listLive.bind(container.repos.workspaces);
    vi.spyOn(container.repos.workspaces, 'listLive').mockImplementation(async () => {
      const rows = await listLive();
      await container.repos.workspaces.setStatus(workspace.id, 'DESTROYED');
      return rows;
    });

    expect(await recoverAbandonedWorkspaces(container)).toBe(0);
    vi.restoreAllMocks();
  });

  /**
   * The case that decides which statuses this pass may take, and the reason `BUSY` is not one of
   * them. A second worker of the same instance boots while the first is executing a run: its claim
   * register is its own, so nothing process-local can see the sibling's hold. Only what the row's
   * owner has committed to can, and a `BUSY` row's owner is running inside that container.
   *
   * Measured before this was narrowed: the boot pass closed the row out, and the very next
   * reconciliation destroyed the container with a live exec in it — the cross-process race the
   * conditional writes exist to remove.
   */
  it('leaves a job workspace a sibling worker is executing in, boot register or not', async () => {
    const workerA = createTestContainer();
    const workspace = await seedJobWorkspace(workerA);
    await workerA.repos.workspaces.claimStatus(workspace.id, 'READY', 'BUSY');
    workerA.claims.claim(workspaceClaimKey(workspace));
    const workerB = { ...workerA, claims: createWorkspaceClaims() };

    const recovered = await recoverAbandonedWorkspaces(workerB);
    const result = await collect(workerB, JOB_NAMES.reapIdle);

    expect(recovered).toBe(0);
    expect((await workerA.repos.workspaces.get(workspace.id))?.status).toBe('BUSY');
    expect(result.orphansDestroyed).toBe(0);
    expect(workerA.runner.getWorkspace(workspace.id)?.status).toBe('running');
  });

  /**
   * A chat workspace left `BUSY` is deliberately not this pass's to take: `recoverStalledWorkspace`
   * owns it on the chat's next turn, and it also writes the SYSTEM note telling the model its
   * filesystem is gone. Closing the row out here would leave that note unwritten.
   */
  it('leaves a chat workspace left busy to the recovery that tells the model', async () => {
    const container = createTestContainer();
    const workspace = await seedWorkspace(container, {
      status: 'BUSY',
      idleMinutes: 0,
      withContainer: true,
    });

    expect(await recoverAbandonedWorkspaces(container)).toBe(0);
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('BUSY');
  });

  /** Nothing to recover on an ordinary boot: no STOPPING row, no write, no log line. */
  it('does nothing when no workspace was left half-torn-down', async () => {
    const container = createTestContainer();
    await seedWorkspace(container, { status: 'READY', idleMinutes: 0 });

    expect(await recoverAbandonedWorkspaces(container)).toBe(0);
  });
});
