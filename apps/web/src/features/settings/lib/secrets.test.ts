/**
 * Unit tests for `lib/secrets.ts`.
 *
 * Layer: unit.
 * Goal: `SECRET_FIELDS` covers both known keys with a matching `statusKey`, `maskSecret` masks
 * with and without a `last4`, and `validateSecretInput` accepts a normal value and rejects every
 * invalid shape (empty, whitespace-only, interior whitespace, too long).
 * Mocks: none.
 */
import { GITHUB_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it } from 'vitest';

import { SECRET_FIELDS, maskSecret, validateSecretInput } from './secrets';

describe('SECRET_FIELDS', () => {
  /**
   * The table is the credentials card: every word of it is what the operator reads while deciding
   * which token to paste and what it will be used for, so it is pinned in full rather than by the
   * two keys. A blank label leaves an unnamed input; a blank helper drops the one line that says a
   * GitHub token needs push access, which is the difference between a job that pushes and one that
   * fails at the end of its work.
   */
  it('describes both credentials, in the words the card shows', () => {
    expect(SECRET_FIELDS).toStrictEqual([
      {
        key: 'GITHUB_PAT',
        label: 'GitHub Personal Access Token',
        placeholder: 'ghp_…',
        helper: 'Needs repo scope (read + push) for the repositories you want to use.',
        toastName: 'GitHub token',
        statusKey: 'githubPat',
      },
      {
        key: 'OPENAI_API_KEY',
        label: 'OpenAI API key',
        placeholder: 'sk-…',
        helper: 'Used by the agent inside workspaces to call OpenAI.',
        toastName: 'OpenAI API key',
        statusKey: 'openaiKey',
      },
    ]);
  });
});

describe('maskSecret', () => {
  /** With a last4, the mask is 8 bullets followed by it. */
  it('appends the last4 after 8 bullets', () => {
    expect(maskSecret('ab12')).toBe('••••••••ab12');
  });

  /** Without a last4 (not yet known), only the 8 bullets show. */
  it('shows only the bullets when last4 is undefined', () => {
    expect(maskSecret(undefined)).toBe('••••••••');
  });
});

describe('validateSecretInput', () => {
  /** A normal, trimmed value passes. */
  it('accepts a normal value', () => {
    expect(validateSecretInput(GITHUB_CANARY)).toBeNull();
  });

  /** An empty (or whitespace-only) value is rejected. */
  it('rejects an empty value', () => {
    expect(validateSecretInput('   ')).toBe('Enter a value.');
  });

  /** A value with interior whitespace is rejected. */
  it('rejects a value with interior whitespace', () => {
    expect(validateSecretInput('not valid')).toBe('Value must not contain whitespace.');
  });

  /** A value over the length cap is rejected. */
  it('rejects a value over 512 characters', () => {
    expect(validateSecretInput('a'.repeat(513))).toBe('Value must be 512 characters or fewer.');
  });

  /** A value exactly at the length cap is accepted. */
  it('accepts a value exactly at the length cap', () => {
    expect(validateSecretInput('a'.repeat(512))).toBeNull();
  });
});
