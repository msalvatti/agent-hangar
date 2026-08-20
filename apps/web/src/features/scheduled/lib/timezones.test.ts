/**
 * Unit tests for the timezone helpers.
 *
 * Layer: unit.
 * Goal: `listTimezones` returns a non-empty list (real or fallback); `systemTimezone` resolves a
 * real zone; `formatNextRun` picks the same-week vs far-out shape.
 * Mocks: `Intl.supportedValuesOf` and `Intl.DateTimeFormat.resolvedOptions` for the fallback path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatNextRun, listTimezones, systemTimezone } from './timezones';

describe('listTimezones', () => {
  /** Returns a non-empty list of timezone names. */
  it('returns a non-empty list', () => {
    expect(listTimezones().length).toBeGreaterThan(0);
    expect(listTimezones()).toContain('UTC');
  });

  /** Falls back to a fixed list when `Intl.supportedValuesOf` is unavailable. */
  it('falls back when supportedValuesOf is unavailable', () => {
    const original = Intl.supportedValuesOf;
    // Simulates an older runtime without this API: `Object.defineProperty` (unlike `delete`)
    // needs no cast, since a required property may still be overwritten to `undefined`.
    Object.defineProperty(Intl, 'supportedValuesOf', { value: undefined, configurable: true });
    expect(listTimezones()).toContain('UTC');
    Object.defineProperty(Intl, 'supportedValuesOf', { value: original, configurable: true });
  });
});

describe('systemTimezone', () => {
  /** Resolves to a real IANA timezone string. */
  it('resolves the system timezone', () => {
    expect(systemTimezone().length).toBeGreaterThan(0);
  });
});

describe('formatNextRun', () => {
  const originalDateNow = Date.now;

  afterEach(() => {
    Date.now = originalDateNow;
    vi.restoreAllMocks();
  });

  /** A run within the next 6 days formats as `Weekday HH:mm`. */
  it('formats a near-term run as weekday + time', () => {
    Date.now = () => new Date('2026-08-19T00:00:00Z').getTime();
    const result = formatNextRun(new Date('2026-08-20T09:00:00Z'), 'UTC');
    expect(result).toBe('Thu 09:00');
  });

  /** A run more than 6 days out formats with the date too. */
  it('formats a far-out run with the date', () => {
    Date.now = () => new Date('2026-08-19T00:00:00Z').getTime();
    const result = formatNextRun(new Date('2026-09-01T09:00:00Z'), 'UTC');
    expect(result).toBe('Tue, Sep 1 09:00');
  });
});
