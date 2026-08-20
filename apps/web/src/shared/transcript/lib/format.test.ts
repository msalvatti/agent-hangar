/**
 * Tests for display formatting helpers: durations, byte counts, UTF-8 sizes, token counts, and
 * relative timestamps.
 */
import { describe, expect, it } from 'vitest';

import {
  formatBytes,
  formatDuration,
  formatElapsed,
  formatTimestamp,
  formatTokens,
  relativeTime,
  utf8ByteLength,
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

describe('utf8ByteLength', () => {
  // ASCII text measures the same either way, which is the common case.
  it('counts one byte per ASCII character', () => {
    expect(utf8ByteLength('README.md')).toBe(9);
  });

  // The unit that matters: `String.length` would report 2 for this, the runtime's budget 6.
  it('counts the UTF-8 bytes of a multi-byte character, not its code units', () => {
    expect(utf8ByteLength('日本')).toBe(6);
  });

  // An empty result measures zero rather than being treated as unknown.
  it('measures empty text as zero', () => {
    expect(utf8ByteLength('')).toBe(0);
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

describe('formatTimestamp', () => {
  const iso = '2026-08-20T15:35:17.824Z';

  // The same instant, spelled as the wall clock of whoever is reading it. The zone is given
  // explicitly, which is what keeps the expectation the same string on every machine.
  it.each([
    ['UTC', 'Aug 20, 2026, 3:35 PM'],
    ['America/Sao_Paulo', 'Aug 20, 2026, 12:35 PM'],
    ['Asia/Tokyo', 'Aug 21, 2026, 12:35 AM'],
  ])('formats the instant in %s', (timeZone, expected) => {
    expect(formatTimestamp(iso, timeZone)).toBe(expected);
  });

  // Nothing of the machine-readable form survives: showing an operator `2026-08-20T15:35:17.824Z`
  // is the defect this replaced.
  it('keeps no trace of the ISO spelling', () => {
    expect(formatTimestamp(iso, 'UTC')).not.toContain(iso);
    expect(formatTimestamp(iso, 'UTC')).not.toContain('T15:35');
  });

  // A string that is not a timestamp has no wall-clock time, and saying so is better than
  // formatting `Invalid Date` or letting `Intl` throw inside a transcript row.
  it('reports a value that is not a timestamp', () => {
    expect(formatTimestamp('not a timestamp', 'UTC')).toBeNull();
  });
});
