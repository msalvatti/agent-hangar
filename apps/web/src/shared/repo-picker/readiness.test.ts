/**
 * Unit tests for the shared "can the agent work here?" answer.
 *
 * Layer: unit.
 * Goal: the three ways a repository disappoints — no commits, archived, read-only token — come out
 * of one function in one vocabulary, in an order a user can act on, and a forge that says nothing
 * is never read as saying yes.
 * Mocks: none; the function is pure.
 */
import { describe, expect, it } from 'vitest';

import { REPO_LIST_SCOPE_NOTE, repoReadiness } from './readiness';

describe('repoReadiness', () => {
  /**
   * The ordinary case: the forge said the token may push and the repository has commits, so the
   * picker has nothing to warn about and renders the row plain.
   */
  it('reports a writable repository as ready, with nothing to say', () => {
    const readiness = repoReadiness({ access: { canPush: true, archived: false } });
    expect(readiness.level).toBe('ready');
    expect(readiness.label).toBeNull();
    expect(readiness.reason).toBeNull();
  });

  /**
   * A forge that reported no permissions is reported as having said nothing. The distinction from
   * `ready` is the point of the level existing: both render without a badge, but only one of them
   * is a claim, and a future reader must not be able to mistake the silence for permission.
   */
  it('reports an unreported access as unknown rather than as writable', () => {
    const readiness = repoReadiness({});
    expect(readiness.level).toBe('unknown');
    expect(readiness.level).not.toBe('ready');
    expect(readiness.label).toBeNull();
  });

  /**
   * A read-only token is a supported configuration — it is what this product tells people to use
   * when they only want questions answered — so it is `limited`, never `blocked`, and the sentence
   * names both what still works and where the token is widened.
   */
  it('reports a read-only token as limited and says where to widen it', () => {
    const readiness = repoReadiness({ access: { canPush: false, archived: false } });
    expect(readiness.level).toBe('limited');
    expect(readiness.label).toBe('Read-only');
    expect(readiness.reason).toContain('Settings');
  });

  /**
   * An archived repository rejects a push from everybody, so the fix is on the forge and not in
   * Settings; it is reported ahead of the token's permissions for exactly that reason.
   */
  it('reports an archived repository as limited, ahead of the token permission', () => {
    const readiness = repoReadiness({ access: { canPush: false, archived: true } });
    expect(readiness.label).toBe('Archived');
    expect(readiness.reason).toContain('unarchived');
  });

  /**
   * A repository whose token may push but which the forge has archived is still archived. Reading
   * only `canPush` would call this one ready and let a turn spend itself before failing to push.
   */
  it('reports an archived repository the token could otherwise push to', () => {
    expect(repoReadiness({ access: { canPush: true, archived: true } }).label).toBe('Archived');
  });

  /**
   * No commits means no ref for `git clone --branch` to name, so nothing works here at all —
   * `blocked`, not `limited` — and it outranks every permission answer, which is why it is checked
   * against a repository that is otherwise perfectly writable.
   */
  it('reports a repository with no branches as blocked, ahead of every access answer', () => {
    const readiness = repoReadiness({
      access: { canPush: true, archived: false },
      hasBranches: false,
    });
    expect(readiness.level).toBe('blocked');
    expect(readiness.label).toBe('No commits yet');
    expect(readiness.reason).toContain('first commit');
  });

  /**
   * A repository that does have branches is judged on its access alone: the branch evidence
   * answers "is it empty", never "may the token push".
   */
  it('falls through to the access answer once branches are known to exist', () => {
    const readiness = repoReadiness({
      access: { canPush: false, archived: false },
      hasBranches: true,
    });
    expect(readiness.level).toBe('limited');
    expect(readiness.label).toBe('Read-only');
  });

  /**
   * The scope note is the escape hatch for a repository somebody cannot find: it has to name the
   * token as the thing that decides the list, and where that token is changed.
   */
  it('explains that the token decides the list, and where to change it', () => {
    expect(REPO_LIST_SCOPE_NOTE).toContain('token');
    expect(REPO_LIST_SCOPE_NOTE).toContain('Settings');
  });
});
