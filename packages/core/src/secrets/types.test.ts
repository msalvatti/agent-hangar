/**
 * Unit tests for the shapes a credential is recognised by.
 *
 * Layer: unit.
 * Goal: each pattern matches the credential form it was written for at the length that form
 * actually has, and refuses the shorter strings that merely start the same way — a pattern that
 * matched those would blank ordinary prose, and one that stopped short of the real length would
 * leave the rest of a credential in the text it was meant to remove it from.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { SECRET_SHAPE_PATTERNS } from './types.ts';

/**
 * Whether any published shape recognises a value.
 *
 * @param value - Text to test.
 * @returns `true` when at least one pattern matches.
 */
function looksLikeSecret(value: string): boolean {
  return SECRET_SHAPE_PATTERNS.some((pattern) => pattern.test(value));
}

describe('SECRET_SHAPE_PATTERNS', () => {
  /**
   * The minimum length each form is recognised at. One character short is a string that begins
   * like a credential and is not one; at the length itself it is the credential, and a pattern
   * that demanded only a single character after the marker would blank every mention of the
   * marker itself.
   */
  it.each([
    [
      'a fine-grained GitHub token',
      1,
      `github_pat_${'a'.repeat(22)}`,
      `github_pat_${'a'.repeat(21)}`,
    ],
    ['a project OpenAI key', 2, `sk-proj-${'a'.repeat(20)}`, `sk-proj-${'a'.repeat(19)}`],
    ['a classic OpenAI key', 3, `sk-${'a'.repeat(20)}`, `sk-${'a'.repeat(19)}`],
  ])(
    'recognises %s at its length and not one character short',
    (_case, index, atLength, tooShort) => {
      // Asked of the pattern for that form rather than of the set: the shorter forms overlap — a
      // project key is also a classic one to the pattern that reads only `sk-` — so a set that
      // recognised the value would say nothing about which pattern did.
      const pattern = SECRET_SHAPE_PATTERNS[index] ?? /$^/u;

      expect(pattern.test(atLength)).toBe(true);
      expect(pattern.test(tooShort)).toBe(false);
    },
  );

  /**
   * The characters after the marker are the alphabet the issuer mints from. A pattern reading the
   * negation of that alphabet matches a run of punctuation instead, which is prose rather than a
   * credential.
   */
  it('does not recognise a marker followed by characters no issuer mints', () => {
    expect((SECRET_SHAPE_PATTERNS[2] ?? /$^/u).test(`sk-proj-${'!'.repeat(20)}`)).toBe(false);
  });

  /**
   * The header is written in several spacings by several clients, and the token is more than one
   * character long. A pattern demanding exactly one space, or matching only the first character of
   * the token, leaves the credential in the line it was meant to take it out of.
   */
  it.each([
    ['no space after the colon', 'Authorization:Bearer abcdefgh'],
    ['several spaces after the colon', 'Authorization:   Bearer abcdefgh'],
    ['several spaces before the token', 'Authorization: Bearer   abcdefgh'],
  ])('recognises an authorization header with %s', (_case, header) => {
    expect(looksLikeSecret(header)).toBe(true);
  });

  /** And the whole token is what is matched, not merely its first character. */
  it('matches the whole bearer token', () => {
    const header = 'Authorization: Bearer abcdefghijklmnop';

    expect(header.replace(SECRET_SHAPE_PATTERNS[4] ?? /$^/u, '[REDACTED]')).toBe('[REDACTED]');
  });
});
