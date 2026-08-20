/**
 * Unit tests for the conditional workspace write of `InMemoryWorkspaceRepository`.
 *
 * Layer: unit.
 * Goal: the contract `claimStatus` promises a caller — one of two callers that read the same status
 * moves the row and the other is told `null`; a winning claim writes exactly what the unconditional
 * write of that status writes; a row that is gone is a lost race rather than an error; and the
 * "one live workspace per chat" invariant binds a claim as it binds `setStatus`. It lives beside the
 * double rather than with the other seven, because a conditional write is deterministic here in a
 * way it can never be against a database: "the row moved" is expressed by moving it.
 * Mocks: FakeClock.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { LiveWorkspaceExistsError } from '../../errors.ts';
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
   * The invariant binds a conditional write too: a claim that would put a second live workspace
   * on one chat is refused rather than granted, exactly as `setStatus` is.
   */
  it('claimStatus is refused when the move would make a second live workspace of one chat', async () => {
    const chat = await seedChat();
    const first = await repos.workspaces.create({ ...input, chatId: chat.id });
    await repos.workspaces.setStatus(first.id, 'FAILED', { failureReason: 'boom' });
    await repos.workspaces.create({ ...input, chatId: chat.id });

    await expect(repos.workspaces.claimStatus(first.id, 'FAILED', 'READY')).rejects.toThrow(
      LiveWorkspaceExistsError,
    );
  });
});
