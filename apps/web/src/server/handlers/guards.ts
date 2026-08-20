/**
 * Preconditions and shared facts for the routes that start or stop agent work.
 *
 * Layer: service (server).
 *
 * These guards answer 409 rather than 400: nothing is wrong with the request, the state is not
 * ready for it. That distinction is what lets the UI point at Settings or at the running turn
 * instead of at the form the user just filled in.
 *
 * {@link requireSoleClaim} and {@link requireStillActive} are the two halves of one concurrency
 * argument, and every route that makes a chat's turn live has to run both *after* its own claim,
 * never only before it. A chat has one work slot and Postgres has no partial unique index over it,
 * so the invariant lives here: each request writes its claim and then re-reads what the other side
 * wrote. Two requests that both proceeded would each have read before the other wrote and written
 * before the other read, which contradicts itself — so they cannot. Checking only beforehand
 * breaks exactly that, and lets a message and a retry, or a retry and an archive, both go through.
 */
import type { SecretKey, UsageTotals } from '@agent-hangar/core';

import type { ServerContainer } from '../container';
import { ConflictError, ResourceNotFoundError } from '../errors';

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

/** Error recorded on a turn whose claim on the chat was given back before any work started. */
export const CLAIM_RELEASED = 'Released: another request claimed the chat at the same moment';

/**
 * Refuses to continue when the chat is no longer accepting work.
 *
 * Read after the caller has written its own claim, so it sees an archive that committed
 * concurrently: the archive's status write and this read are ordered the same way on both sides,
 * which is what stops work and an archive from both proceeding.
 *
 * @param container - The server container.
 * @param chatId - Chat to re-read.
 * @throws ResourceNotFoundError 404 when the chat was deleted meanwhile.
 * @throws ConflictError 409 `CHAT_ARCHIVED` when the chat was archived meanwhile.
 */
export async function requireStillActive(
  container: ServerContainer,
  chatId: string,
): Promise<void> {
  const chat = await container.repos.chats.getById(chatId);
  if (chat === null) {
    throw new ResourceNotFoundError('Chat not found');
  }
  if (chat.status !== 'ACTIVE') {
    throw new ConflictError('CHAT_ARCHIVED', 'The chat was archived while the request was sent');
  }
}

/**
 * Refuses to continue when the chat carries a live turn other than the caller's own claim.
 *
 * Losing on sight rather than by comparing ids is what keeps the rule single-valued under every
 * interleaving: the request that never saw a rival is the only one that can win, so two requests
 * can both refuse but can never both proceed.
 *
 * @param container - The server container.
 * @param chatId - Chat the claim was made against.
 * @param turnId - The caller's own claim, excluded from the check.
 * @throws ConflictError 409 `TURN_IN_PROGRESS` when another live turn exists.
 */
export async function requireSoleClaim(
  container: ServerContainer,
  chatId: string,
  turnId: string,
): Promise<void> {
  const turns = await container.repos.turns.listByChat(chatId);
  if (turns.some((turn) => turn.id !== turnId && isLive(turn.status))) {
    throw new ConflictError(
      'TURN_IN_PROGRESS',
      'Another request claimed this chat at the same moment; try it again',
    );
  }
}
