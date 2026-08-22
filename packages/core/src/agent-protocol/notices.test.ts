/**
 * Unit tests for the transcript notice vocabulary.
 *
 * Layer: unit.
 * Goal: the push notice renders one text for both the live stream and the stored message, a sha
 * is shortened without being padded, and a stored message is classified back into the tone the
 * live stream showed it in — a push as a success, every other lifecycle note as a warning.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import {
  isPrepareWarning,
  prepareWarningText,
  preparedNoticeText,
  pushedNoticeText,
  shortSha,
  systemNoticeTone,
} from './notices.ts';

describe('shortSha', () => {
  /** A full sha is cut to the seven characters a transcript line shows. */
  it('keeps the first seven characters of a full sha', () => {
    expect(shortSha('0123456789abcdef0123456789abcdef01234567')).toBe('0123456');
  });

  /** An already-short sha is returned untouched rather than padded out. */
  it('leaves a shorter sha alone', () => {
    expect(shortSha('abc')).toBe('abc');
  });
});

describe('preparedNoticeText', () => {
  /**
   * The branch in full and the commit shortened, exactly as the push notice spells the same two
   * things. The line has two builders — the live stream and the reload — and this is the one they
   * share, so drift between them would have to start here.
   */
  it('names the branch in full and shortens the commit', () => {
    expect(preparedNoticeText('agent/018f3a2b', '0123456789abcdef0123456789abcdef01234567')).toBe(
      'Prepared agent/018f3a2b at 0123456',
    );
  });
});

describe('pushedNoticeText', () => {
  /** The branch is shown in full and the sha shortened, which is the line the reducer renders. */
  it('names the branch and the shortened commit', () => {
    expect(pushedNoticeText('agent/1a2b3c4d', '0123456789abcdef')).toBe(
      'Pushed agent/1a2b3c4d @ 0123456',
    );
  });
});

describe('systemNoticeTone', () => {
  /** The stored push notice is the one that reports something going right. */
  it('classifies a stored push notice as a success', () => {
    expect(systemNoticeTone(pushedNoticeText('agent/1a2b3c4d', 'abcdef1234'))).toBe('success');
  });

  /** Every other lifecycle note is something the operator has to account for. */
  it.each([
    'Workspace archived; no uncommitted changes.',
    'The previous workspace stopped responding and was replaced.',
    'Push failed',
  ])('classifies %s as a warning', (content) => {
    expect(systemNoticeTone(content)).toBe('warning');
  });
});

describe('prepareWarningText / isPrepareWarning', () => {
  /**
   * The pair is the whole point: the runtime marks the message and the transcript reads the mark
   * back, so neither end spells the marker itself and the two cannot drift apart.
   */
  it('recognises a message it built', () => {
    expect(isPrepareWarning(prepareWarningText('the branch diverged'))).toBe(true);
  });

  /** Ordinary preparation progress is not a finding and must keep collapsing onto one line. */
  it.each(['Cloning https://github.com/acme/api (branch main)…', 'Resumed agent/x at abcdef1'])(
    'does not recognise %s',
    (message) => {
      expect(isPrepareWarning(message)).toBe(false);
    },
  );

  /** The marker is a prefix on the text, so the message the operator reads still starts with it. */
  it('keeps the message it was given', () => {
    expect(prepareWarningText('HEAD moved')).toBe('Warning: HEAD moved');
  });
});
