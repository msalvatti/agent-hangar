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
  /** Returns a non-empty list of timezone names, `UTC` among them. */
  it('returns a non-empty list', () => {
    expect(listTimezones().length).toBeGreaterThan(0);
    expect(listTimezones()).toContain('UTC');
  });

  /**
   * `UTC` is added when the runtime's own list omits it. Some ICU builds list only `Etc/UTC`,
   * while `Intl.DateTimeFormat` accepts the bare name and this app's defaults use it — so a picker
   * built from the runtime's list alone would have no entry for the zone every job starts with.
   */
  it('adds UTC when the runtime does not list it', () => {
    const original = Intl.supportedValuesOf;
    Object.defineProperty(Intl, 'supportedValuesOf', {
      value: () => ['Etc/UTC', 'Europe/Lisbon'],
      configurable: true,
    });

    expect(listTimezones()).toStrictEqual(['UTC', 'Etc/UTC', 'Europe/Lisbon']);

    Object.defineProperty(Intl, 'supportedValuesOf', { value: original, configurable: true });
  });

  /**
   * And it is not added twice when the runtime does list it: a duplicate entry is a duplicate row
   * in the picker.
   */
  it('does not repeat UTC when the runtime lists it', () => {
    const original = Intl.supportedValuesOf;
    Object.defineProperty(Intl, 'supportedValuesOf', {
      value: () => ['UTC', 'Europe/Lisbon'],
      configurable: true,
    });

    expect(listTimezones()).toStrictEqual(['UTC', 'Europe/Lisbon']);

    Object.defineProperty(Intl, 'supportedValuesOf', { value: original, configurable: true });
  });

  /** Falls back to a fixed list when `Intl.supportedValuesOf` is unavailable. */
  it('falls back when supportedValuesOf is unavailable', () => {
    const original = Intl.supportedValuesOf;
    // Simulates an older runtime without this API: `Object.defineProperty` (unlike `delete`)
    // needs no cast, since a required property may still be overwritten to `undefined`.
    Object.defineProperty(Intl, 'supportedValuesOf', { value: undefined, configurable: true });
    // The fallback is a usable list rather than an empty one: a picker with no options is a job
    // dialog nobody can complete, and these twenty cover the zones this app is run in.
    const zones = listTimezones();
    expect(zones).toContain('UTC');
    expect(zones).toStrictEqual([
      'UTC',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'America/Sao_Paulo',
      'America/Mexico_City',
      'Europe/London',
      'Europe/Berlin',
      'Europe/Paris',
      'Europe/Madrid',
      'Europe/Moscow',
      'Africa/Cairo',
      'Africa/Johannesburg',
      'Asia/Dubai',
      'Asia/Kolkata',
      'Asia/Shanghai',
      'Asia/Tokyo',
      'Asia/Singapore',
      'Australia/Sydney',
    ]);
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

  /**
   * Exactly six days out is still the short form. The weekday alone is unambiguous up to a full
   * week ahead, and taking the date away one instant early — or adding it one instant late — is
   * the difference between "Wed 09:00" meaning this Wednesday and meaning any Wednesday.
   */
  it('keeps the short form at exactly six days', () => {
    Date.now = () => new Date('2026-08-19T00:00:00Z').getTime();

    expect(formatNextRun(new Date('2026-08-25T00:00:00Z'), 'UTC')).toBe('Tue 00:00');
    expect(formatNextRun(new Date('2026-08-25T00:00:01Z'), 'UTC')).toBe('Tue, Aug 25 00:00');
  });
});
