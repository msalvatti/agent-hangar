/**
 * Preconditions and shared facts for the routes that start or stop agent work.
 *
 * Layer: service (server).
 *
 * Both guards answer 409 rather than 400: nothing is wrong with the request, the state is not
 * ready for it. That distinction is what lets the UI point at Settings or at the running turn
 * instead of at the form the user just filled in.
 */
import type { SecretKey, UsageTotals } from '@agent-hangar/core';

import type { ServerContainer } from '../container';
import { ConflictError } from '../errors';

/**
 * Usage recorded for a turn or run that is closed without ever having executed.
 *
 * Cancelling a queued turn and failing an enqueue both end work that consumed no tokens and took
 * no steps, and the repositories require the totals either way.
 */
export const NO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, stepCount: 0 };

/** Turn and run statuses that mean work is already under way. */
export const LIVE_STATUSES: readonly string[] = ['QUEUED', 'PREPARING', 'RUNNING'];

/** Credentials a turn cannot start without: one to clone with, one to think with. */
const REQUIRED_SECRETS: readonly SecretKey[] = ['GITHUB_PAT', 'OPENAI_API_KEY'];

/**
 * Refuses to start work while a credential is missing.
 *
 * Checked before any row is written, so a chat is never created for a turn that could not run.
 *
 * @param container - The server container.
 * @throws ConflictError 409 `SECRETS_MISSING` naming the keys that are unset.
 */
export async function requireSecrets(container: ServerContainer): Promise<void> {
  const status = await container.secrets.status();
  const missing = REQUIRED_SECRETS.filter((key) => !status[key].set);
  if (missing.length > 0) {
    throw new ConflictError(
      'SECRETS_MISSING',
      `Configure the missing credentials in Settings: ${missing.join(', ')}`,
    );
  }
}

/**
 * Whether a lifecycle status means work is still under way.
 *
 * @param status - A turn or run status, or `undefined` for a row that is gone.
 * @returns `true` while the work is queued or executing.
 */
export function isLive(status: string | undefined): boolean {
  return status !== undefined && LIVE_STATUSES.includes(status);
}

/**
 * Refuses an operation while a turn of the chat is still running.
 *
 * Archiving, deleting or queueing a second turn under a live one would each race the worker: it
 * holds a container for that turn and writes rows against it.
 *
 * @param container - The server container.
 * @param chatId - Chat to inspect.
 * @throws ConflictError 409 `TURN_IN_PROGRESS` when a turn is queued or executing.
 */
export async function requireNoLiveTurn(container: ServerContainer, chatId: string): Promise<void> {
  const turns = await container.repos.turns.listByChat(chatId);
  if (turns.some((turn) => isLive(turn.status))) {
    throw new ConflictError('TURN_IN_PROGRESS', 'Wait for the running turn to finish or cancel it');
  }
}
