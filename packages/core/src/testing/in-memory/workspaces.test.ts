/**
 * Unit tests for the conditional workspace write of `InMemoryWorkspaceRepository`.
 *
 * Layer: unit.
 * Goal: what this double adds on top of the shared `claimStatus` contract, which it is also held to
 * just above — a winning claim writes exactly what the unconditional write of that status writes;
 * a row that is gone is a lost race rather than an error; and the
 * lifecycle refusal arrives before the invariant a revival would otherwise reach. It lives beside the
 * double rather than with the other seven, because a conditional write is deterministic here in a
 * way it can never be against a database: "the row moved" is expressed by moving it.
 * Mocks: FakeClock.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { IllegalTransitionError } from '../../errors.ts';
import { describeWorkspaceClaimContract } from '../../persistence/testing/workspace-claim-contract.ts';
import { FakeClock } from '../fake-clock.ts';
import { createInMemoryRepositories } from '../in-memory-repositories.ts';
import type { InMemoryRepositories } from '../in-memory-repositories.ts';

const T0 = new Date('2026-08-19T10:00:00.000Z');

const input = {
  kind: 'CHAT' as const,
  runnerKind: 'fake',
  image: 'img',
  repoUrl: 'u',
  branch: 'main',
};

let clock: FakeClock;
let repos: InMemoryRepositories;

beforeEach(() => {
  clock = new FakeClock(T0);
  repos = createInMemoryRepositories(clock);
});

/** Seeds a chat for the workspaces that need an owner. */
async function seedChat(): Promise<{ id: string }> {
  return repos.chats.create({
    title: 'Fix tests',
    repoUrl: 'https://github.com/acme/w',
    baseBranch: 'main',
  });
}

describeWorkspaceClaimContract('InMemoryWorkspaceRepository', {
  repository: () => repos.workspaces,
  seed: async (status) => {
    const workspace = await repos.workspaces.create(input);
    if (status === 'CREATING') {
      return workspace;
    }
    await repos.workspaces.setStatus(workspace.id, 'READY');
    return status === 'READY' ? workspace : repos.workspaces.setStatus(workspace.id, status);
  },
});

describe('InMemoryWorkspaceRepository.claimStatus', () => {
  /**
   * The contract of a conditional write, stated as the race it exists to arbitrate: two callers
   * read the same `READY` row and both try to take it. The first moves it and gets the row back;
   * the second names a status the row no longer holds and is told so with `null`, instead of
   * overwriting a state it never saw. The row is left holding what the winner wrote.
   */
  it('claimStatus lets exactly one of two callers move a row out of the status they both read', async () => {
    const chat = await seedChat();
    const workspace = await repos.workspaces.create({ ...input, chatId: chat.id });
    await repos.workspaces.setStatus(workspace.id, 'READY');

    const won = await repos.workspaces.claimStatus(workspace.id, 'READY', 'BUSY');
    const lost = await repos.workspaces.claimStatus(workspace.id, 'READY', 'STOPPING');

    expect(won?.status).toBe('BUSY');
    expect(lost).toBeNull();
    expect((await repos.workspaces.get(workspace.id))?.status).toBe('BUSY');
  });

  /**
   * A winning claim is indistinguishable from the unconditional write of the same status: the
   * same guarded `readyAt` stamp, the same `destroyedAt` stamp, the same optional columns. A
   * caller that switches from `setStatus` to `claimStatus` changes only what happens when it
   * loses.
   */
  it('claimStatus writes exactly what setStatus writes when it wins', async () => {
    const workspace = await repos.workspaces.create(input);
    clock.advance(1000);
    const ready = await repos.workspaces.claimStatus(workspace.id, 'CREATING', 'READY', {
      runnerRef: 'container-1',
    });
    expect(ready).toMatchObject({ status: 'READY', runnerRef: 'container-1' });
    expect(ready?.readyAt).toEqual(clock.now());

    clock.advance(1000);
    const destroyed = await repos.workspaces.claimStatus(workspace.id, 'READY', 'DESTROYED', {
      failureReason: 'container missing',
    });
    expect(destroyed?.destroyedAt).toEqual(clock.now());
    expect(destroyed?.failureReason).toBe('container missing');
    expect(destroyed?.readyAt).toEqual(ready?.readyAt);
  });

  /**
   * A row that is gone is a lost race like any other: the caller may not act, and it learns that
   * the same way. `setStatus` throws `NotFoundError` there, which a claim deliberately does not —
   * a claim asks whether it may act, and "no" is an answer rather than a failure.
   */
  it('claimStatus answers null for a workspace that does not exist', async () => {
    expect(await repos.workspaces.claimStatus('missing', 'READY', 'BUSY')).toBeNull();
  });

  /**
   * This once asserted that the "one live workspace per chat" invariant refuses a claim reviving a
   * dead row beside a live sibling. Refusing lifecycle-illegal moves made that unreachable and
   * replaced it with something stronger: no dead status has a live successor, so a claim can no
   * longer *reach* the invariant, and the refusal arrives before the row or its siblings are
   * consulted at all. What is pinned here is that earlier refusal; `setStatus`, which can still be
   * asked to revive a row, keeps the invariant test of its own.
   */
  it('claimStatus cannot reach the live-workspace invariant, because reviving a row is refused first', async () => {
    const chat = await seedChat();
    const first = await repos.workspaces.create({ ...input, chatId: chat.id });
    await repos.workspaces.setStatus(first.id, 'FAILED', { failureReason: 'boom' });
    const sibling = await repos.workspaces.create({ ...input, chatId: chat.id });

    await expect(repos.workspaces.claimStatus(first.id, 'FAILED', 'READY')).rejects.toThrow(
      IllegalTransitionError,
    );
    expect((await repos.workspaces.get(first.id))?.status).toBe('FAILED');
    expect((await repos.workspaces.findLiveByChat(chat.id))?.id).toBe(sibling.id);
  });
});
