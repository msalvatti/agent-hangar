/**
 * Telling an infrastructure failure apart from a failure of the work itself.
 *
 * Layer: utility.
 *
 * The distinction decides whether a processor rejects or resolves. A Docker daemon that is not
 * listening is worth retrying, because the next attempt may find it back; a runtime that exited
 * non-zero is not, because the next attempt would do exactly the same thing and the user would
 * collect one failed turn per retry.
 *
 * Security: classification is a membership test against literals written in this file. No pattern
 * can separate a driver code from a credential — `SUPERSECRETPW` is as much a bare identifier as
 * `ECONNREFUSED` — so nothing carried in by the error is ever echoed, only matched.
 */

/**
 * Error codes that mean the worker could not reach the Docker daemon.
 *
 * These are the errnos a local socket connection produces: the daemon is down, the socket path is
 * wrong, the user is not in the `docker` group, or the connection dropped mid-request. A remote
 * daemon adds the DNS and routing errnos.
 */
export const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  'EACCES',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOENT',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

/** How far the `cause` chain is walked; a cycle or a deep chain must not hang the worker. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Reads the `code` a rejected value offers, without trusting it to be readable.
 *
 * The value is `unknown`: a getter or a `Proxy` trap may throw, and what it throws could itself be
 * the driver error carrying the connection string, so it is swallowed rather than propagated.
 *
 * @param error - The value something rejected with.
 * @returns Its `code`, or `undefined`.
 */
function readCode(error: unknown): string | undefined {
  try {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const { code } = error;
      return typeof code === 'string' ? code : undefined;
    }
  } catch {
    // A throwing getter answers the question well enough: nothing usable is on offer.
  }
  return undefined;
}

/**
 * Reports whether a failure is the infrastructure being unreachable.
 *
 * Walks the `cause` chain, because the Docker runner wraps daemon failures in its own typed error
 * and puts the socket error underneath.
 *
 * @param error - The value a runner call rejected with.
 * @returns `true` when the worker should reject the job so BullMQ retries it.
 */
export function isTransportError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    const code = readCode(current);
    if (code !== undefined && TRANSPORT_ERROR_CODES.has(code)) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
