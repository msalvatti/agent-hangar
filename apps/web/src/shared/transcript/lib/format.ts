/**
 * Display formatting for durations, byte counts, commit hashes and relative timestamps.
 *
 * Layer: shared (formatting).
 *
 * Pure functions only: every caller supplies its own clock so output stays deterministic in
 * tests. Shared between the chats and scheduled-jobs features.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Formats an elapsed duration as a running clock: `mm:ss`, or `h:mm:ss` past one hour.
 *
 * @param ms - Elapsed milliseconds (negative values are clamped to zero).
 * @returns The formatted clock.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND_MS));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${String(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  }
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

/**
 * Formats a short duration for a finished step or tool call: sub-minute durations as seconds
 * with one decimal (`0.3 s`), longer ones as a `mm:ss` clock.
 *
 * @param ms - Duration in milliseconds (negative values are clamped to zero).
 * @returns The formatted duration.
 */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < MINUTE_MS) {
    return `${(clamped / SECOND_MS).toFixed(1)} s`;
  }
  return formatElapsed(clamped);
}

const KILOBYTE = 1024;
const MEGABYTE = KILOBYTE * 1024;

/**
 * Formats a byte count with the smallest unit that keeps it readable (`B`, `KB`, `MB`).
 *
 * @param bytes - Non-negative byte count.
 * @returns The formatted size, one decimal past `B`.
 */
export function formatBytes(bytes: number): string {
  const value = Math.max(0, bytes);
  if (value < KILOBYTE) {
    return `${String(value)} B`;
  }
  if (value < MEGABYTE) {
    return `${(value / KILOBYTE).toFixed(1)} KB`;
  }
  return `${(value / MEGABYTE).toFixed(1)} MB`;
}

/**
 * Shortens a commit SHA to its first 7 characters.
 *
 * @param sha - Full or already-short SHA.
 * @returns The first 7 characters (the whole string when shorter).
 */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Formats a token count with thousands separators.
 *
 * @param tokens - Non-negative token count.
 * @returns The formatted count, e.g. `12,345`.
 */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

/**
 * Formats an ISO timestamp relative to now: `just now`, `5m ago`, `2h ago`, `3d ago`, or, for a
 * future timestamp, `in 21h` / `in 2d`.
 *
 * @param iso - ISO-8601 timestamp.
 * @param now - Reference time in epoch milliseconds.
 * @returns The relative label.
 */
export function relativeTime(iso: string, now: number): string {
  const target = Date.parse(iso);
  const deltaMs = target - now;
  const future = deltaMs > 0;
  const magnitude = Math.abs(deltaMs);

  if (magnitude < MINUTE_MS) {
    return future ? 'in less than a minute' : 'just now';
  }
  if (magnitude < HOUR_MS) {
    const minutes = Math.floor(magnitude / MINUTE_MS);
    return future ? `in ${String(minutes)}m` : `${String(minutes)}m ago`;
  }
  if (magnitude < DAY_MS) {
    const hours = Math.floor(magnitude / HOUR_MS);
    return future ? `in ${String(hours)}h` : `${String(hours)}h ago`;
  }
  const days = Math.floor(magnitude / DAY_MS);
  return future ? `in ${String(days)}d` : `${String(days)}d ago`;
}

/**
 * How a timestamp is spelled out for a reader: `Aug 20, 2026, 3:35 PM`.
 *
 * The locale is fixed rather than taken from the browser, for the same reason the whole file takes
 * its clock from the caller: the output has to be the same string on every machine that runs the
 * tests. The product's copy is English throughout, so a fixed `en-US` is not a compromise here.
 */
const TIMESTAMP_LOCALE = 'en-US';

/**
 * Formats an ISO timestamp as a wall-clock time in a given zone.
 *
 * The zone is a parameter, not a reading of the ambient one: `Intl` resolves the *running*
 * machine's zone, which on a server is not the reader's, so a caller that wants the reader's zone
 * has to obtain it in the browser and hand it in.
 *
 * @param iso - ISO-8601 timestamp.
 * @param timeZone - IANA zone name to express the instant in.
 * @returns The formatted timestamp, or `null` when `iso` is not a timestamp at all.
 */
export function formatTimestamp(iso: string, timeZone: string): string | null {
  const epochMs = Date.parse(iso);
  if (Number.isNaN(epochMs)) {
    return null;
  }
  return new Intl.DateTimeFormat(TIMESTAMP_LOCALE, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(epochMs);
}
