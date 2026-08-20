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

import { pushedNoticeText, shortSha, systemNoticeTone } from './notices.ts';

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
