/**
 * Tests for the display-layer secret masking: every canary and every shape pattern must be
 * scrubbed before text reaches a component, and ordinary text/JSON must pass through untouched.
 */
import { CANARY_VALUES, GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it } from 'vitest';

import { maskSecretShapes, toDisplayJson } from './redact-display';

describe('maskSecretShapes', () => {
  // Every registered canary (one per secret shape pattern in active use) is masked.
  it('masks every canary value', () => {
    for (const canary of CANARY_VALUES) {
      expect(maskSecretShapes(`token=${canary}`)).toBe('token=[REDACTED]');
    }
  });

  // A GitHub PAT embedded in a longer sentence is masked in place.
  it('masks a GitHub PAT inside surrounding text', () => {
    const text = `export GITHUB_TOKEN=${GITHUB_CANARY} # do not commit`;
    expect(maskSecretShapes(text)).toBe('export GITHUB_TOKEN=[REDACTED] # do not commit');
  });

  // An OpenAI key embedded in a longer sentence is masked in place.
  it('masks an OpenAI key inside surrounding text', () => {
    const text = `key: ${OPENAI_CANARY}`;
    expect(maskSecretShapes(text)).toBe('key: [REDACTED]');
  });

  // An Authorization header is masked regardless of case.
  it('masks an Authorization: Bearer header', () => {
    expect(maskSecretShapes('Authorization: Bearer abc.def.ghi')).toBe('[REDACTED]');
  });

  // Text with no secret shape is returned unchanged.
  it('leaves ordinary text untouched', () => {
    expect(maskSecretShapes('rg -n "login" tests/')).toBe('rg -n "login" tests/');
  });

  // Ordinary hex (e.g. a commit SHA) is not mistaken for a secret shape.
  it('leaves an ordinary hex SHA untouched', () => {
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    expect(maskSecretShapes(sha)).toBe(sha);
  });
});

describe('toDisplayJson', () => {
  // A plain object is pretty-printed with 2-space indentation.
  it('pretty-prints an object with 2-space indent', () => {
    expect(toDisplayJson({ a: 1, b: 'two' })).toBe('{\n  "a": 1,\n  "b": "two"\n}');
  });

  // A secret embedded in a serializable value is masked after stringification.
  it('masks a canary embedded in a serialized value', () => {
    expect(toDisplayJson({ token: GITHUB_CANARY })).toBe(`{\n  "token": "[REDACTED]"\n}`);
  });

  // `JSON.stringify` returns `undefined` (not a string) for a top-level `undefined` value; the
  // `?? String(value)` fallback covers that case without throwing.
  it('falls back to String() when JSON.stringify yields undefined', () => {
    expect(toDisplayJson(undefined)).toBe('undefined');
  });

  // A circular reference cannot be serialized; the fallback path is exercised (its generic
  // `String()` form carries no secret text, so nothing is left to mask here).
  it('falls back to String() for a circular value', () => {
    const circular: { self?: unknown; token: string } = { token: OPENAI_CANARY };
    circular.self = circular;
    expect(toDisplayJson(circular)).toBe('[object Object]');
  });
});
