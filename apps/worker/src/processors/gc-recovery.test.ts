/**
 * Unit tests for the workspace recovery a worker performs at boot.
 *
 * Layer: unit.
 * Goal: a row a dead incarnation left `STOPPING` is closed out so its container becomes an orphan
 * the collector removes, a row an owner may still hold is left alone, and the pass reports what it
 * changed without ever needing the Docker daemon — which is what lets it run ahead of the runner
 * probe in `prepareBoot`.
 * Mocks: `createTestContainer` with a `FakeClock`.
 */
import { JOB_NAMES } from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import { chatClaimKey, createWorkspaceClaims, workspaceClaimKey } from '../claims.js';
import { collect, createTestContainer, seedJobWorkspace, seedWorkspace } from '../testing/index.js';

import { ABANDONED_TEARDOWN_REASON, recoverAbandonedWorkspaces } from './gc.js';

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
