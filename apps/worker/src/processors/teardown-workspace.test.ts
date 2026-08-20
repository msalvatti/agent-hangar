/**
 * Unit tests for workspace teardown.
 *
 * Layer: unit.
 * Goal: restore hints written only when nothing is unpushed, the normative note text for both
 * reasons, a snapshot failure that does not stop the destroy, a destroy failure recorded rather
 * than thrown, a workspace another writer took while the record was being written, the two live
 * statuses a teardown may not take a workspace from, and a job workspace that leaves no message
 * behind.
 * Mocks: `createTestContainer` plus runner subclasses for the failures the fake cannot produce.
 */
import type { Workspace, WorkspaceSnapshot } from '@agent-hangar/core';
import { FakeWorkspaceRunner, GITHUB_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { createTestContainer } from '../testing/index.js';
import type { TestContainer } from '../testing/index.js';

import { countDirtyEntries, formatTeardownNote, teardownWorkspace } from './teardown-workspace.js';

/** A runner whose snapshots always fail. */
class BlindRunner extends FakeWorkspaceRunner {
  override async snapshot(): Promise<WorkspaceSnapshot> {
    await Promise.resolve();
    throw new Error('container is not responding');
  }
}

/** Builds a snapshot with the given git state and summary. */
function snapshot(git: Partial<WorkspaceSnapshot['git']>, summary = ''): WorkspaceSnapshot {
  return {
    takenAt: new Date('2026-01-01T00:00:00.000Z'),
    git: { branch: null, headSha: null, dirty: false, ahead: 0, behind: 0, ...git },
    summary,
  };
}

/** Seeds a live chat workspace and returns it with its chat id. */
async function seedChatWorkspace(
  container: TestContainer,
): Promise<{ workspace: Workspace; chatId: string }> {
  const chat = await container.repos.chats.create({
    title: 'Task',
    repoUrl: 'https://github.com/octocat/Hello-World',
    baseBranch: 'main',
  });
  const created = await container.repos.workspaces.create({
    kind: 'CHAT',
    chatId: chat.id,
    runnerKind: 'fake',
    image: 'image',
    repoUrl: 'https://github.com/octocat/Hello-World',
    branch: 'main',
  });
  const workspace = await container.repos.workspaces.setStatus(created.id, 'READY', {
    runnerRef: 'ref-1',
  });
  await container.runner.create({
    workspaceId: workspace.id,
    kind: 'CHAT',
    image: 'image',
    env: {},
    limits: { cpus: 1, memoryBytes: 1, pids: 1 },
    labels: {},
  });
  return { workspace, chatId: chat.id };
}

describe('countDirtyEntries', () => {
  /**
   * The summary carries `git status --porcelain` and `git diff --stat` in one string; only the
   * porcelain half counts as an uncommitted change.
   */
  it('counts porcelain entries and ignores the diff stat', () => {
    const summary = [
      ' M src/index.ts',
      '?? notes.md',
      'A  added.ts',
      '',
      ' src/index.ts | 4 ++--',
      ' 1 file changed, 2 insertions(+), 2 deletions(-)',
    ].join('\n');

    expect(countDirtyEntries(snapshot({}, summary))).toBe(3);
  });

  /**
   * A clean workspace reports nothing.
   */
  it('counts nothing in an empty summary', () => {
    expect(countDirtyEntries(snapshot({}))).toBe(0);
  });
});

describe('formatTeardownNote', () => {
  /**
   * The idle note names the TTL and agrees with the count, because it is shown verbatim in the
   * transcript.
   */
  it('reads correctly for one, many and no idle changes', () => {
    expect(formatTeardownNote({ reason: 'idle', idleMinutes: 30 }, 1)).toContain(
      '1 uncommitted change discarded',
    );
    expect(formatTeardownNote({ reason: 'idle', idleMinutes: 30 }, 2)).toContain(
      '2 uncommitted changes discarded',
    );
    const clean = formatTeardownNote({ reason: 'idle', idleMinutes: 30 }, 0);
    expect(clean).toContain('after 30 min idle');
    expect(clean).toContain('no uncommitted changes');
    expect(clean).toContain('recreated from history');
  });

  /**
   * An idle teardown with no TTL to name still produces a sentence rather than `undefined min`.
   */
  it('reads correctly without an idle duration', () => {
    expect(formatTeardownNote({ reason: 'idle' }, 0)).toContain('after 0 min idle');
  });

  /**
   * The archive note is the one the restore contract defines, so it is taken from there rather
   * than respelled.
   */
  it('uses the archive notice for an archived chat', () => {
    expect(formatTeardownNote({ reason: 'archive' }, 2)).toBe(
      'Workspace archived; 2 uncommitted changes discarded.',
    );
  });
});

describe('teardownWorkspace', () => {
  /**
   * A workspace with nothing unpushed hands the chat the branch and commit a later turn checks
   * out, and tells the model what it lost.
   */
  it('writes restore hints and a note, then destroys the container', async () => {
    const container = createTestContainer();
    const { workspace, chatId } = await seedChatWorkspace(container);
    vi.spyOn(container.runner, 'snapshot').mockResolvedValue(
      snapshot({ branch: 'agent/abc', headSha: 'deadbee', ahead: 0 }, ' M src/index.ts'),
    );

    const outcome = await teardownWorkspace(container, workspace, {
      reason: 'idle',
      idleMinutes: 30,
    });

    expect(outcome).toBe('destroyed');
    expect(await container.repos.chats.getById(chatId)).toMatchObject({
      workBranch: 'agent/abc',
      lastPushedSha: 'deadbee',
    });
    const messages = await container.repos.messages.listByChat(chatId);
    expect(messages.at(-1)?.content).toContain('1 uncommitted change discarded');
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('DESTROYED');
    vi.restoreAllMocks();
  });

  /**
   * Commits that never left the container must not be advertised: pointing a later turn at that
   * branch would make it check out work that does not exist on the remote.
   */
  it('writes no hints when work is still unpushed', async () => {
    const container = createTestContainer();
    const { workspace, chatId } = await seedChatWorkspace(container);
    vi.spyOn(container.runner, 'snapshot').mockResolvedValue(
      snapshot({ branch: 'agent/abc', headSha: 'deadbee', ahead: 2 }),
    );

    await teardownWorkspace(container, workspace, { reason: 'archive' });

    expect(await container.repos.chats.getById(chatId)).toMatchObject({
      workBranch: null,
      lastPushedSha: null,
    });
    vi.restoreAllMocks();
  });

  /**
   * A container that cannot be read is still destroyed: the alternative is leaving it running
   * forever because it stopped answering.
   */
  it('destroys a workspace it could not snapshot', async () => {
    const container = createTestContainer({ runner: new BlindRunner() });
    const { workspace, chatId } = await seedChatWorkspace(container);

    const outcome = await teardownWorkspace(container, workspace, { reason: 'archive' });

    expect(outcome).toBe('destroyed');
    expect(container.logs.join('')).toContain('could not snapshot a workspace');
    const messages = await container.repos.messages.listByChat(chatId);
    expect(messages.at(-1)?.content).toBe('Workspace archived; no uncommitted changes.');
    expect(await container.repos.chats.getById(chatId)).toMatchObject({ workBranch: null });
  });

  /**
   * A destroy the daemon refuses leaves the row `FAILED` with a redacted reason and reports it,
   * so one bad container cannot stop the collector's pass.
   */
  it('records a destroy that failed, with a redacted reason', async () => {
    const container = createTestContainer();
    const { workspace } = await seedChatWorkspace(container);
    container.redactor.register([GITHUB_CANARY]);
    vi.spyOn(container.runner, 'destroy').mockRejectedValue(
      new Error(`remove refused for ${GITHUB_CANARY}`),
    );

    const outcome = await teardownWorkspace(container, workspace, { reason: 'idle' });

    expect(outcome).toBe('failed');
    expect(await container.repos.workspaces.get(workspace.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'remove refused for [REDACTED]',
    });
    expect(container.logs.join('')).not.toContain(GITHUB_CANARY);
    vi.restoreAllMocks();
  });

  /**
   * A rejection that is not an `Error` still produces a reason rather than `undefined`.
   */
  it('records a non-error destroy failure', async () => {
    const container = createTestContainer();
    const { workspace } = await seedChatWorkspace(container);
    vi.spyOn(container.runner, 'destroy').mockRejectedValue('daemon said no');

    await teardownWorkspace(container, workspace, { reason: 'idle' });

    expect((await container.repos.workspaces.get(workspace.id))?.failureReason).toBe(
      'daemon said no',
    );
    vi.restoreAllMocks();
  });

  /**
   * The chat's record is written before the row moves to `STOPPING`, because the lifecycle lets
   * `STOPPING` lead only to `DESTROYED` or `FAILED`. A repository that refuses the note therefore
   * leaves the row exactly as it was — still `READY`, still idle, its container still running — so
   * a later pass tears the workspace down instead of finding a row nothing can ever finish and a
   * container no reconciliation will ever reclaim.
   */
  it('leaves the row untouched when the chat record cannot be written', async () => {
    const container = createTestContainer();
    const { workspace } = await seedChatWorkspace(container);
    const append = vi
      .spyOn(container.repos.messages, 'append')
      .mockRejectedValue(new Error('database is down'));

    const outcome = await teardownWorkspace(container, workspace, {
      reason: 'idle',
      idleMinutes: 30,
    });

    expect(outcome).toBe('failed');
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('READY');
    expect(container.runner.calls.some((call) => call.method === 'destroy')).toBe(false);
    expect(container.logs.join('')).toContain('recording what a chat needs');

    append.mockRestore();
    const retried = await teardownWorkspace(container, workspace, {
      reason: 'idle',
      idleMinutes: 30,
    });

    expect(retried).toBe('destroyed');
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('DESTROYED');
    vi.restoreAllMocks();
  });

  /**
   * Reading the row, snapshotting the container and writing the chat's record all take time, and a
   * turn can take the workspace while they run. The `STOPPING` write names the status that read
   * reported, so the teardown that lost stops there: the row still says what the other writer put
   * in it, and the container that turn is executing in is still standing.
   */
  it('stops rather than destroying a workspace another writer took while it recorded', async () => {
    const container = createTestContainer();
    const { workspace } = await seedChatWorkspace(container);
    const append = container.repos.messages.append.bind(container.repos.messages);
    vi.spyOn(container.repos.messages, 'append').mockImplementation(
      async (chatId, role, content, turnId) => {
        await container.repos.workspaces.setStatus(workspace.id, 'BUSY');
        return append(chatId, role, content, turnId);
      },
    );

    const outcome = await teardownWorkspace(container, workspace, {
      reason: 'idle',
      idleMinutes: 30,
    });

    expect(outcome).toBe('skipped');
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('BUSY');
    expect(container.runner.calls.some((call) => call.method === 'destroy')).toBe(false);
    expect(container.logs.join('')).toContain('was taken while its record was written');
    vi.restoreAllMocks();
  });

  /**
   * `READY` is the only live status nobody owns. `CREATING` belongs to whoever is provisioning,
   * `BUSY` to the turn executing inside the container, `STOPPING` to another teardown. A teardown
   * handed a row in one of those has not lost a race — it never had a claim to make — so it stops
   * before it snapshots anything, and the chat is told nothing: the note would say the workspace
   * was reclaimed while the turn that owns it is still writing to the filesystem.
   */
  it('does not touch a workspace a turn is executing in', async () => {
    const container = createTestContainer();
    const { workspace, chatId } = await seedChatWorkspace(container);
    const busy = await container.repos.workspaces.setStatus(workspace.id, 'BUSY');

    const outcome = await teardownWorkspace(container, busy, { reason: 'archive' });

    expect(outcome).toBe('skipped');
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('BUSY');
    expect(container.runner.calls.some((call) => call.method === 'destroy')).toBe(false);
    expect(await container.repos.messages.listByChat(chatId)).toHaveLength(0);
    expect(container.logs.join('')).toContain('not free to stop');
  });

  /**
   * The same rule read from the other side: a row left `STOPPING` by a teardown that died is owned
   * by that teardown, not free. Naming the status found rather than `READY` would let two
   * teardowns claim `STOPPING` from `STOPPING` and both believe they had won, destroying the same
   * container twice.
   */
  it('does not let a second teardown claim a workspace already being stopped', async () => {
    const container = createTestContainer();
    const { workspace } = await seedChatWorkspace(container);
    const stopping = await container.repos.workspaces.setStatus(workspace.id, 'STOPPING');

    const first = await teardownWorkspace(container, stopping, { reason: 'archive' });
    const second = await teardownWorkspace(container, stopping, { reason: 'archive' });

    expect([first, second]).toEqual(['skipped', 'skipped']);
    expect(container.runner.calls.filter((call) => call.method === 'destroy')).toHaveLength(0);
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('STOPPING');
  });

  /**
   * A scheduled run's workspace belongs to no chat, so there is nobody to write hints or a note
   * for; it is simply destroyed. It is `READY` here for the same reason every workspace a teardown
   * is handed is: that is the only status one may be taken from.
   */
  it('leaves no message behind for a job workspace', async () => {
    const container = createTestContainer();
    const created = await container.repos.workspaces.create({
      kind: 'JOB',
      runnerKind: 'fake',
      image: 'image',
      repoUrl: 'https://github.com/octocat/Hello-World',
      branch: 'master',
    });
    const workspace = await container.repos.workspaces.setStatus(created.id, 'READY');

    const outcome = await teardownWorkspace(container, workspace, { reason: 'archive' });

    expect(outcome).toBe('destroyed');
    expect(container.repos.store.messages.size).toBe(0);
  });
});
