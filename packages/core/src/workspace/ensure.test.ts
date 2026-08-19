/**
 * Unit tests for the ensure-workspace decision.
 *
 * Layer: unit.
 * Goal: a missing image fails before anything else, a ready workspace is reused, every state that
 * cannot be reused yields a create decision or a busy error, and restore is not a special path.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { WorkspaceImageMissing } from '../errors.js';

import { ensureWorkspaceDecision } from './ensure.js';
import type { EnsureWorkspaceInput } from './ensure.js';
import { WorkspaceBusyError } from './errors.js';
import type { RestoreContext, WorkspaceStatus } from './types.js';

/** Restore context shared by the cases; identity matters, so it is created once. */
const RESTORE: RestoreContext = {
  repoUrl: 'https://github.com/acme/api',
  baseBranch: 'main',
  workBranch: 'agent/018f3a2b',
  lastPushedSha: 'abc1234',
  messages: [],
  restoredAt: new Date('2026-01-01T00:00:00.000Z'),
};

/**
 * Builds an input with an available image and no live workspace.
 *
 * @param overrides - Fields to change.
 * @returns The decision input.
 */
function input(overrides: Partial<EnsureWorkspaceInput> = {}): EnsureWorkspaceInput {
  return {
    liveWorkspace: null,
    image: 'agent-hangar/workspace:dev',
    imagePresent: true,
    restore: RESTORE,
    ...overrides,
  };
}

describe('ensureWorkspaceDecision', () => {
  /**
   * The image check comes first, even when a workspace could have been reused: without the image
   * no decision is executable, and the typed error carries the build instruction.
   */
  it('fails on a missing image before anything else', () => {
    expect.assertions(2);
    try {
      ensureWorkspaceDecision(
        input({ imagePresent: false, liveWorkspace: { id: 'ws-1', status: 'READY' } }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceImageMissing);
      expect((error as WorkspaceImageMissing).image).toBe('agent-hangar/workspace:dev');
    }
  });

  /**
   * A chat with no live workspace — new, archived and restored, or reaped by the collector — is
   * created and cloned; the restore context is passed through by reference, not copied.
   */
  it('creates and clones when there is no live workspace', () => {
    const decision = ensureWorkspaceDecision(input());
    expect(decision).toEqual({ action: 'create', clone: true, restore: RESTORE });
    expect(decision.action === 'create' && decision.restore).toBe(RESTORE);
  });

  /**
   * A defensively fetched row that is no longer live takes the same create branch, so a stale read
   * cannot wedge a chat.
   */
  it('creates when the workspace row is no longer live', () => {
    const statuses: WorkspaceStatus[] = ['DESTROYED', 'FAILED'];
    for (const status of statuses) {
      expect(ensureWorkspaceDecision(input({ liveWorkspace: { id: 'ws-1', status } }))).toEqual({
        action: 'create',
        clone: true,
        restore: RESTORE,
      });
    }
  });

  /**
   * The second and later messages of a chat reuse the running container, which is what keeps the
   * clone out of every turn.
   */
  it('reuses a ready workspace', () => {
    expect(
      ensureWorkspaceDecision(input({ liveWorkspace: { id: 'ws-1', status: 'READY' } })),
    ).toEqual({ action: 'reuse', workspaceId: 'ws-1' });
  });

  /**
   * A transient state means another actor owns the workspace; creating a second one would violate
   * the one-live-workspace-per-chat invariant, so the caller runs stalled recovery instead.
   */
  it('refuses a workspace in a transient state', () => {
    const statuses: WorkspaceStatus[] = ['CREATING', 'BUSY', 'STOPPING'];
    expect.assertions(statuses.length * 3);
    for (const status of statuses) {
      try {
        ensureWorkspaceDecision(input({ liveWorkspace: { id: 'ws-1', status } }));
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceBusyError);
        expect((error as WorkspaceBusyError).code).toBe('WORKSPACE_BUSY');
        expect((error as WorkspaceBusyError).message).toContain(`workspace ws-1 is ${status}`);
      }
    }
  });

  /**
   * A status this build does not know — a row written by a newer version — is reported rather
   * than silently treated as reusable.
   */
  it('reports an unknown status', () => {
    const status = 'PARKED' as unknown as WorkspaceStatus;
    expect(() => ensureWorkspaceDecision(input({ liveWorkspace: { id: 'ws-1', status } }))).toThrow(
      /unhandled case: "PARKED"/,
    );
  });
});
