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
  /** Both secret keys are present, each with the `statusKey` matching its contract field. */
  it('lists GitHub and OpenAI with their settingsStatus field names', () => {
    expect(SECRET_FIELDS.map((field) => field.key)).toEqual(['GITHUB_PAT', 'OPENAI_API_KEY']);
    expect(SECRET_FIELDS.find((field) => field.key === 'GITHUB_PAT')?.statusKey).toBe('githubPat');
    expect(SECRET_FIELDS.find((field) => field.key === 'OPENAI_API_KEY')?.statusKey).toBe(
      'openaiKey',
    );
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
