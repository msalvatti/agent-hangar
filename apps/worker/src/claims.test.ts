/**
 * Unit tests for the workspace claim register.
 *
 * Layer: unit.
 * Goal: a key one holder took cannot be taken again until it is given back, keys of different
 * chats do not collide, and a chat workspace answers to the same key its chat's turns claim — the
 * property that makes the collector and the turn processor contend rather than pass each other.
 * Mocks: none; the register is pure process state.
 */
import { describe, expect, it } from 'vitest';

import { chatClaimKey, createWorkspaceClaims, turnClaimKey, workspaceClaimKey } from './claims.js';

describe('createWorkspaceClaims', () => {
  /**
   * The whole point: the second caller is told no rather than being handed shared ownership of a
   * container the first one is about to write to.
   */
  it('gives a key to one holder at a time', () => {
    const claims = createWorkspaceClaims();

    expect(claims.claim('chat:c1')).toBe(true);
    expect(claims.claim('chat:c1')).toBe(false);
  });

  /**
   * Holding one key must not lock the machine: a turn of another chat runs alongside.
   */
  it('keeps unrelated keys independent', () => {
    const claims = createWorkspaceClaims();

    claims.claim('chat:c1');

    expect(claims.claim('chat:c2')).toBe(true);
  });

  /**
   * A released key is free again, so the next message to a chat is not refused for ever because
   * the previous one held its workspace.
   */
  it('frees a key that was given back', () => {
    const claims = createWorkspaceClaims();
    claims.claim('chat:c1');

    claims.release('chat:c1');

    expect(claims.claim('chat:c1')).toBe(true);
  });

  /**
   * Releasing something nobody holds is what a `finally` does after a claim that was refused; it
   * must not throw, and must not hand out a key twice.
   */
  it('tolerates releasing a key nobody holds', () => {
    const claims = createWorkspaceClaims();

    claims.release('chat:c1');

    expect(claims.claim('chat:c1')).toBe(true);
  });
});

describe('the shape of a claim key', () => {
  /**
   * The three prefixes are what keep the namespaces apart, and they are written out here rather
   * than compared with one another: a chat, a workspace and a turn are contended for by different
   * parts of the worker at the same moment, and two of them sharing a prefix would let a chat's
   * turn take the key its own workspace collector is waiting on. Compared only against each other,
   * all three could lose their prefix at once and every comparison would still hold.
   */
  it('names the chat, the workspace and the turn namespaces', () => {
    expect(chatClaimKey('c1')).toBe('chat:c1');
    expect(workspaceClaimKey({ id: 'ws-1', chatId: null })).toBe('workspace:ws-1');
    expect(turnClaimKey('t1')).toBe('turn:t1');
  });
});

describe('workspaceClaimKey', () => {
  /**
   * A turn knows its chat long before it knows which workspace it will run in, so a chat's
   * workspace is claimed under the chat's key — otherwise the collector and the turn processor
   * would take two different keys for the same container and never see each other.
   */
  it('keys a chat workspace by its chat', () => {
    expect(workspaceClaimKey({ id: 'ws-1', chatId: 'c1' })).toBe(chatClaimKey('c1'));
  });

  /**
   * A scheduled run's workspace has no chat, and a chat workspace loses its reference when the
   * chat is deleted; both are still claimable, by their own id.
   */
  it('keys a workspace with no chat by its own id', () => {
    const key = workspaceClaimKey({ id: 'ws-1', chatId: null });

    expect(key).toBe('workspace:ws-1');
    expect(key).not.toBe(chatClaimKey('ws-1'));
  });
});
