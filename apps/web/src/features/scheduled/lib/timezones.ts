/**
 * IANA timezone listing and formatting helpers for the job dialog.
 *
 * Layer: service (adapter).
 */

/** A reasonable fallback list of common timezones for environments without `Intl.supportedValuesOf`. */
const FALLBACK_TIMEZONES: readonly string[] = [
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
];

/**
 * Lists every IANA timezone the runtime knows about.
 *
 * @returns The timezone names, or {@link FALLBACK_TIMEZONES} when `Intl.supportedValuesOf` is
 *   unavailable.
 */
export function listTimezones(): string[] {
  const zones =
    typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [...FALLBACK_TIMEZONES];
  // `Intl.supportedValuesOf('timeZone')` lists IANA zone names (`Etc/UTC`, `America/...`) but not
  // the bare `UTC` identifier some ICU builds omit, even though `Intl.DateTimeFormat` accepts it
  // and this app's mock data and defaults use it.
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
}

/**
 * The system's configured IANA timezone.
 *
 * @returns The resolved timezone (`Intl` always resolves one; there is no unset case).
 */
export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * Formats a future run instant for the cron preview: `Mon 09:00` within the next 6 days, or
 * `Mon 12 Aug 09:00` further out.
 *
 * @param date - The instant to format.
 * @param timezone - IANA timezone to format it in.
 * @returns The formatted label.
 */
export function formatNextRun(date: Date, timezone: string): string {
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const time = timeFormatter.format(date);
  const isFarOut = date.getTime() - Date.now() > SIX_DAYS_MS;
  if (!isFarOut) {
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
    }).format(date);
    return `${weekday} ${time}`;
  }
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return `${dateFormatter.format(date)} ${time}`;
}
