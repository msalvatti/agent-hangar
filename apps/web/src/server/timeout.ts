/**
 * Bounded waits for the health probes.
 *
 * Layer: utility (server).
 *
 * A probe exists to answer "is this reachable", so it must answer even when the thing it probes
 * never does. Every probe therefore races a timer that is always cleared, so a slow database
 * cannot leave a pending timer behind after the response has gone out.
 *
 * What the race bounds is the response, not the work: losing a race does not cancel anything, and
 * an operation that is still in flight still holds whatever it holds. That is why the work itself
 * carries its own deadline, set where the connection is made rather than here. Postgres is given a
 * `statement_timeout` in the container's connection string, so the server ends the statement and
 * hands the pooled connection back instead of letting a polled endpoint accumulate one checked-out
 * connection per poll. A Redis command holds no pooled resource — the commands of one client share
 * one socket — and ioredis rejects everything still outstanding when that socket goes, so the
 * driver ends those waits too. Adding a caller-side deadline here as well would only duplicate
 * bounds the drivers already enforce.
 */

/** Reported when a probe did not answer in time. */
export const TIMED_OUT = 'timeout';

/** Outcome of one probe. */
export interface ProbeResult {
  ok: boolean;
  /** Latency in milliseconds when the probe answered. */
  latencyMs?: number;
  /** Why it failed; always a value written in this repository, never a driver's own text. */
  detail?: string;
}

/**
 * Races a promise against a timer.
 *
 * The promise is not cancelled when the timer wins; see the module header for where the work is
 * actually given a deadline.
 *
 * @param work - The promise to await.
 * @param timeoutMs - How long to wait.
 * @param onTimeout - Value produced when the wait runs out.
 * @returns The promise's value, or `onTimeout`.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(onTimeout());
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}
