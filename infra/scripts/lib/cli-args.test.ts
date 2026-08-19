/**
 * Unit tests for `parseFlags`.
 *
 * Layer: unit.
 * Goal: allowed flags collect their value or `true`, an empty argv parses to an empty map, and
 * both an unknown flag and a stray positional argument throw.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { parseFlags } from './cli-args.js';

describe('parseFlags', () => {
  /**
   * No arguments parse to an empty map.
   */
  it('returns an empty map for an empty argv', () => {
    expect(parseFlags([], { allowed: ['days'] })).toEqual({});
  });

  /**
   * A flag followed by a non-flag word takes that word as its value.
   */
  it('takes the following word as the flag value', () => {
    expect(parseFlags(['--days', '7'], { allowed: ['days'] })).toEqual({ days: '7' });
  });

  /**
   * A flag at the end of argv, or followed by another flag, has no value and is `true`.
   */
  it('is true when the flag has no following value', () => {
    expect(parseFlags(['--dry-run'], { allowed: ['dry-run'] })).toEqual({ 'dry-run': true });
    expect(parseFlags(['--dry-run', '--force'], { allowed: ['dry-run', 'force'] })).toEqual({
      'dry-run': true,
      force: true,
    });
  });

  /**
   * Several flags parse in one call, mixing valued and boolean flags.
   */
  it('parses several flags in one call', () => {
    expect(parseFlags(['--days', '7', '--dry-run'], { allowed: ['days', 'dry-run'] })).toEqual({
      days: '7',
      'dry-run': true,
    });
  });

  /**
   * A flag outside `allowed` throws, naming the flag.
   */
  it('throws on an unknown flag', () => {
    expect(() => parseFlags(['--nope'], { allowed: ['days'] })).toThrow('Unknown flag: --nope');
  });

  /**
   * A bare word that does not start with `--` throws as an unexpected argument.
   */
  it('throws on a stray positional argument', () => {
    expect(() => parseFlags(['nope'], { allowed: ['days'] })).toThrow('Unexpected argument: nope');
  });
});
