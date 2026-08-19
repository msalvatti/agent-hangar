/**
 * Tests for display formatting helpers: durations, byte counts, SHAs, token counts, and relative
 * timestamps.
 */
import { describe, expect, it } from 'vitest';

import {
  formatBytes,
  formatDuration,
  formatElapsed,
  formatTokens,
  relativeTime,
  shortSha,
} from './format';

describe('formatElapsed', () => {
  // Sub-minute durations render as mm:ss.
  it('formats seconds as mm:ss', () => {
    expect(formatElapsed(5_000)).toBe('00:05');
  });

  // Durations past a minute still render as mm:ss.
  it('formats minutes as mm:ss', () => {
    expect(formatElapsed(90_000)).toBe('01:30');
  });

  // Durations past an hour switch to h:mm:ss.
  it('formats hours as h:mm:ss', () => {
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
  });

  // Negative input (clock skew) is clamped to zero instead of showing a negative time.
  it('clamps negative durations to zero', () => {
    expect(formatElapsed(-500)).toBe('00:00');
  });
});

describe('formatDuration', () => {
  // Short durations show one decimal of seconds.
  it('formats sub-minute durations with one decimal', () => {
    expect(formatDuration(300)).toBe('0.3 s');
    expect(formatDuration(2_100)).toBe('2.1 s');
  });

  // Durations at or past a minute fall back to the mm:ss clock.
  it('formats minute-plus durations as a clock', () => {
    expect(formatDuration(72_000)).toBe('01:12');
  });

  // Negative durations are clamped before formatting.
  it('clamps negative durations to zero', () => {
    expect(formatDuration(-10)).toBe('0.0 s');
  });
});

describe('formatBytes', () => {
  // Sub-kilobyte values render in bytes with no decimal.
  it('formats bytes below 1024 with no unit conversion', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  // Kilobyte-range values get one decimal.
  it('formats kilobytes with one decimal', () => {
    expect(formatBytes(2_048)).toBe('2.0 KB');
  });

  // Megabyte-range values scale a second time.
  it('formats megabytes with one decimal', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  // Negative counts are clamped to zero.
  it('clamps negative byte counts to zero', () => {
    expect(formatBytes(-100)).toBe('0 B');
  });
});

describe('shortSha', () => {
  // A full 40-character SHA is truncated to 7 characters.
  it('truncates a full SHA to 7 characters', () => {
    expect(shortSha('abcdef1234567890')).toBe('abcdef1');
  });

  // A SHA already 7 characters or shorter is returned unchanged.
  it('returns a short SHA unchanged', () => {
    expect(shortSha('abc')).toBe('abc');
  });
});

describe('formatTokens', () => {
  // Large counts gain thousands separators.
  it('adds thousands separators', () => {
    expect(formatTokens(12_345)).toBe('12,345');
  });

  // Small counts render without separators.
  it('formats small counts without separators', () => {
    expect(formatTokens(42)).toBe('42');
  });
});

describe('relativeTime', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  // Timestamps within the last minute read as "just now".
  it('reads "just now" for the last minute', () => {
    const iso = new Date(now - 10_000).toISOString();
    expect(relativeTime(iso, now)).toBe('just now');
  });

  // Timestamps minutes in the past render as "<n>m ago".
  it('formats minutes in the past', () => {
    const iso = new Date(now - 5 * 60_000).toISOString();
    expect(relativeTime(iso, now)).toBe('5m ago');
  });

  // Timestamps hours in the past render as "<n>h ago".
  it('formats hours in the past', () => {
    const iso = new Date(now - 2 * 3_600_000).toISOString();
    expect(relativeTime(iso, now)).toBe('2h ago');
  });

  // Timestamps days in the past render as "<n>d ago".
  it('formats days in the past', () => {
    const iso = new Date(now - 3 * 86_400_000).toISOString();
    expect(relativeTime(iso, now)).toBe('3d ago');
  });

  // A future timestamp within a minute reads as an immediate future.
  it('reads a near-future timestamp distinctly from the past', () => {
    const iso = new Date(now + 10_000).toISOString();
    expect(relativeTime(iso, now)).toBe('in less than a minute');
  });

  // Future timestamps hours away render as "in <n>h".
  it('formats hours in the future', () => {
    const iso = new Date(now + 21 * 3_600_000).toISOString();
    expect(relativeTime(iso, now)).toBe('in 21h');
  });

  // Future timestamps days away render as "in <n>d".
  it('formats days in the future', () => {
    const iso = new Date(now + 2 * 86_400_000).toISOString();
    expect(relativeTime(iso, now)).toBe('in 2d');
  });

  // Future timestamps minutes away render as "in <n>m".
  it('formats minutes in the future', () => {
    const iso = new Date(now + 15 * 60_000).toISOString();
    expect(relativeTime(iso, now)).toBe('in 15m');
  });
});
