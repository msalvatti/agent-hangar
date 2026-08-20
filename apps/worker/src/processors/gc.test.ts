/**
 * Unit tests for the workspace collector.
 *
 * Layer: unit.
 * Goal: only idle `READY` workspaces are reclaimed, a container this instance owns with no live
 * row is destroyed, a live row whose container is gone is closed out unless a turn is running
 * against it, another instance's containers are never touched, and the archive job tears down the
 * one workspace of its chat.
 * Mocks: `createTestContainer` with a `FakeClock`.
 */
import { JOB_NAMES } from '@agent-hangar/core';
import type { Workspace } from '@agent-hangar/core';
import { FakeClock } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { createTestContainer } from '../testing/index.js';
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
