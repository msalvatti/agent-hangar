/**
 * Unit tests for the shared "can the agent work here?" answer.
 *
 * Layer: unit.
 * Goal: the three ways a repository disappoints — no branch, archived, read-only token — come out
 * of one function in one vocabulary, in an order a user can act on; every fact is independent, and
 * a fact the forge never stated is never invented in either direction.
 * Mocks: none; the functions are pure.
 */
import { describe, expect, it } from 'vitest';

import { repoListNote, repoReadiness } from './readiness';

describe('repoReadiness', () => {
  /**
   * The ordinary case: the forge stated both facts and both are favourable, so the picker has
   * nothing to warn about and renders the row plain.
   */
  it('reports a writable, unarchived repository as ready, with nothing to say', () => {
    const readiness = repoReadiness({ canPush: true, archived: false });
    expect(readiness.level).toBe('ready');
    expect(readiness.label).toBeNull();
    expect(readiness.reason).toBeNull();
  });

  /**
   * A forge that reported neither fact is reported as having said nothing. The distinction from
   * `ready` is the point of the level existing: both render without a badge, but only one of them
   * is a claim, and a future reader must not be able to mistake the silence for permission.
   */
  it('reports an unreported repository as unknown rather than as writable', () => {
    const readiness = repoReadiness({});
    expect(readiness.level).toBe('unknown');
    expect(readiness.level).not.toBe('ready');
    expect(readiness.label).toBeNull();
  });

  /**
   * The half-stated cases, which a single bundled answer got wrong in both directions. A stated
   * `canPush: true` beside an unstated `archived` is not ready — the repository may well be
   * archived and nobody said it was not — and a stated `archived: false` says nothing about
   * whether the token may push.
   */
  it.each([
    ['push stated, archived unstated', { canPush: true }],
    ['archived stated false, push unstated', { archived: false }],
  ])('refuses to call a half-stated repository ready (%s)', (_label, facts) => {
    const readiness = repoReadiness(facts);
    expect(readiness.level).toBe('unknown');
    expect(readiness.label).toBeNull();
  });

  /**
   * The other half-stated direction, and the one that used to be silently discarded: a forge that
   * reports `archived` without reporting `permissions` still gets its repository badged, because
   * an archived repository rejects a push whatever the token turns out to be allowed to do.
   */
  it('reports an archived repository even when nothing was said about the token', () => {
    const readiness = repoReadiness({ archived: true });
    expect(readiness.level).toBe('limited');
    expect(readiness.label).toBe('Archived');
  });

  /**
   * A read-only token is a supported configuration — it is what this product tells people to use
   * when they only want questions answered — so it is `limited`, never `blocked`, and the sentence
   * names both what still works and where the token is widened.
   */
  it('reports a read-only token as limited and says where to widen it', () => {
    const readiness = repoReadiness({ canPush: false, archived: false });
    expect(readiness.level).toBe('limited');
    expect(readiness.label).toBe('Read-only');
    expect(readiness.reason).toContain('Settings');
  });

  /**
   * An archived repository rejects a push from everybody, so the fix is on the forge and not in
   * Settings; it is reported ahead of the token's permissions for exactly that reason.
   */
  it('reports an archived repository as limited, ahead of the token permission', () => {
    const readiness = repoReadiness({ canPush: false, archived: true });
    expect(readiness.label).toBe('Archived');
    expect(readiness.reason).toContain('unarchived');
  });

  /**
   * A repository whose token may push but which the forge has archived is still archived. Reading
   * only `canPush` would call this one ready and let a turn spend itself before failing to push.
   */
  it('reports an archived repository the token could otherwise push to', () => {
    expect(repoReadiness({ canPush: true, archived: true }).label).toBe('Archived');
  });

  /**
   * No branch means no ref for `git clone --branch` to name, so nothing works here at all —
   * `blocked`, not `limited` — and it outranks every permission answer, which is why it is checked
   * against a repository that is otherwise perfectly writable.
   */
  it('reports a repository with no branches as blocked, ahead of every access answer', () => {
    const readiness = repoReadiness({ canPush: true, archived: false, hasBranches: false });
    expect(readiness.level).toBe('blocked');
    expect(readiness.label).toBe('No branches');
    expect(readiness.reason).toContain('Push a branch');
  });

  /**
   * The sentence describes what was observed, not what it implies. An empty branch listing proves
   * there is no branch; it does not prove there is no commit, because a repository whose commits
   * are reachable only through tags has both — so the wording must not claim otherwise.
   */
  it('does not claim a repository without branches has no commits', () => {
    const readiness = repoReadiness({ hasBranches: false });
    expect(readiness.label).not.toMatch(/commit/i);
    expect(readiness.reason).not.toMatch(/commit/i);
  });

  /**
   * A repository that does have branches is judged on its access alone: the branch evidence
   * answers "is there anything to clone", never "may the token push".
   */
  it('falls through to the access answer once branches are known to exist', () => {
    const readiness = repoReadiness({ canPush: false, archived: false, hasBranches: true });
    expect(readiness.level).toBe('limited');
    expect(readiness.label).toBe('Read-only');
  });
});

describe('repoListNote', () => {
  /**
   * The escape hatch for a repository somebody cannot find: when the listing did reach the end of
   * the account, the token really is what decides the list, so the note names it and says where it
   * is changed.
   */
  it('blames the token scope only when the listing was complete', () => {
    const note = repoListNote(false);
    expect(note).toContain('token');
    expect(note).toContain('Settings');
  });

  /**
   * When the listing stopped at the page limit the token was never the problem, and sending
   * somebody to widen it is worse than saying nothing. The truncated note must not mention
   * Settings, and must say the search itself is incomplete — the part no user could deduce from an
   * empty result.
   */
  it('does not blame the token scope when the listing was truncated', () => {
    const note = repoListNote(true);
    expect(note).not.toContain('Settings');
    expect(note).toMatch(/search/i);
    expect(note).not.toBe(repoListNote(false));
  });
});
