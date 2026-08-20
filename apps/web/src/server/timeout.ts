/**
 * Bounded waits for the health probes.
 *
 * Layer: utility (server).
 *
 * A probe exists to answer "is this reachable", so it must answer even when the thing it probes
 * never does. Every probe therefore races a timer that is always cleared, so a slow database
 * cannot leave a pending timer behind after the response has gone out.
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
