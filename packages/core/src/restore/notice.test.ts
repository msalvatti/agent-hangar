/**
 * Unit tests for the workspace notices.
 *
 * Layer: unit.
 * Goal: both restoration variants and both archive variants render the exact normative text, with
 * the instant in ISO form.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { archivedNotice, RESTORATION_NOTICE_PREFIX, restorationNotice } from './notice.js';

/** Fixed instant so the rendered text is byte-comparable. */
const AT = new Date('2026-03-01T12:34:56.000Z');

describe('restorationNotice', () => {
  /**
   * With pushed work the notice names the branch that was checked out, so the model knows which
   * of its commits survived.
   */
  it('names the work branch when there is one', () => {
    expect(restorationNotice({ at: AT, workBranch: 'agent/018f3a2b' })).toBe(
      'Workspace recreated from history at 2026-03-01T12:34:56.000Z. Uncommitted changes from the previous workspace are gone; pushed work on `agent/018f3a2b` is checked out.',
    );
  });

  /**
   * Without pushed work the notice says so explicitly rather than leaving the model to assume its
   * files are still there.
   */
  it('says so when there is no pushed work', () => {
    expect(restorationNotice({ at: AT, workBranch: null })).toBe(
      'Workspace recreated from history at 2026-03-01T12:34:56.000Z. Uncommitted changes from the previous workspace are gone; no pushed work was found, so the base branch is checked out.',
    );
  });

  /**
   * Both variants start with the same prefix, which is how the turn builder recognises a notice a
   * previous step already inserted.
   */
  it('shares a detectable prefix', () => {
    expect(
      restorationNotice({ at: AT, workBranch: 'main' }).startsWith(RESTORATION_NOTICE_PREFIX),
    ).toBe(true);
    expect(
      restorationNotice({ at: AT, workBranch: null }).startsWith(RESTORATION_NOTICE_PREFIX),
    ).toBe(true);
  });
});

describe('archivedNotice', () => {
  /**
   * A clean workspace says nothing was lost, which is the common case and reassures the user when
   * they reopen the chat.
   */
  it('reports a clean archive', () => {
    expect(archivedNotice({ uncommittedChanges: 0 })).toBe(
      'Workspace archived; no uncommitted changes.',
    );
  });

  /**
   * When work was discarded the count is recorded, so the transcript shows what the archive cost.
   */
  it('reports discarded changes', () => {
    expect(archivedNotice({ uncommittedChanges: 1 })).toBe(
      'Workspace archived; 1 uncommitted changes discarded.',
    );
    expect(archivedNotice({ uncommittedChanges: 5 })).toBe(
      'Workspace archived; 5 uncommitted changes discarded.',
    );
  });
});
