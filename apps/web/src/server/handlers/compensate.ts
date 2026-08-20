/**
 * Shared helper for undoing a durable write once a paired operation that follows it fails.
 *
 * Layer: service (server).
 *
 * Postgres and Redis cannot enlist in one transaction, and neither can two Postgres writes a
 * single handler makes back to back without a shared transaction of their own. Several handlers in
 * this package reach agreement between such a pair by compensation instead of atomicity: the first
 * write lands, a second operation that can fail is attempted, and a failure of the second undoes
 * the first. `compensate` is that undo step, factored out because `handlers/jobs.ts` and
 * `handlers/chats.ts` both need it against different pairs of stores.
 *
 * The guarantee stops where the undo itself fails. Raising that second failure would replace the
 * error that actually explains the request's 500 with one that hides it, so it is logged instead,
 * with the fields the caller supplies to name the row. Nothing left in this function repairs the
 * mismatch; the two halves stay disagreeing until an operator reads the log line or a later
 * request rewrites both from scratch.
 */
import type { ServerContainer } from '../container';
import { failureName } from '../errors';

/**
 * Runs the write that undoes a partial change, reporting rather than raising if it also fails.
 *
 * @param container - The server container, for its logger.
 * @param fields - Structured fields logged alongside the failure, naming the row being repaired
 *   (e.g. `{ jobId }` or `{ chatId }`).
 * @param message - What could not be undone, written to the log line.
 * @param undo - The write that restores the previous state.
 * @returns Resolves once the row is back, or once the failure to put it back has been reported.
 */
export async function compensate(
  container: ServerContainer,
  fields: Readonly<Record<string, string>>,
  message: string,
  undo: () => Promise<unknown>,
): Promise<void> {
  try {
    await undo();
  } catch (error) {
    container.logger.error({ failure: failureName(error), ...fields }, message);
  }
}
