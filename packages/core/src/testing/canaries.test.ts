/**
 * Unit tests for the secret canaries.
 *
 * Layer: unit.
 * Goal: the canaries match the shape patterns the redactor must catch (so they are realistic
 * stand-ins), are obviously fake, and `assertNoCanary` reports exactly the leaked ones.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { SECRET_SHAPE_PATTERNS } from '../secrets/types.js';

import {
  assertNoCanary,
  CANARY_MARKER,
  CANARY_VALUES,
  GITHUB_CANARY,
  OPENAI_CANARY,
} from './canaries.js';

describe('canaries', () => {
  /**
   * Shape realism: each canary must be matched by at least one shape pattern, otherwise a
   * redaction test that passes with canaries would prove nothing about real tokens.
   */
  it('match the secret shape patterns', () => {
    for (const canary of CANARY_VALUES) {
      expect(SECRET_SHAPE_PATTERNS.some((pattern) => pattern.test(canary))).toBe(true);
    }
    expect(GITHUB_CANARY).toMatch(/^ghp_[A-Za-z0-9]{36}$/);
    expect(OPENAI_CANARY).toMatch(/^sk-[A-Za-z0-9_-]{20,}$/);
  });

  /**
   * Obviously fake: every canary carries the `TESTCANARY` marker so a leaked value can never
   * be mistaken for a real credential, and the list contains exactly the two canaries.
   */
  it('carry the TESTCANARY marker and are listed once each', () => {
    expect(GITHUB_CANARY).toContain(CANARY_MARKER);
    expect(OPENAI_CANARY).toContain(CANARY_MARKER);
    expect(CANARY_VALUES).toEqual([GITHUB_CANARY, OPENAI_CANARY]);
  });
});

describe('assertNoCanary', () => {
  /**
   * Clean text passes silently.
   */
  it('passes on text without canaries', () => {
    expect(() => {
      assertNoCanary('all good [REDACTED] here');
    }).not.toThrow();
  });

  /**
   * Each canary alone is detected, and a text containing both names both in the error so the
   * failing test shows the full picture.
   */
  it('throws naming every leaked canary', () => {
    expect(() => {
      assertNoCanary(`token=${GITHUB_CANARY}`);
    }).toThrow(GITHUB_CANARY);
    expect(() => {
      assertNoCanary(`key=${OPENAI_CANARY}`);
    }).toThrow(OPENAI_CANARY);
    expect(() => {
      assertNoCanary(`${GITHUB_CANARY} ${OPENAI_CANARY}`);
    }).toThrow(`Secret canary leaked: ${GITHUB_CANARY}, ${OPENAI_CANARY}`);
  });
});
