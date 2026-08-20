/**
 * The step every route that starts agent work ends with: handing a claimed turn to the worker.
 *
 * Layer: service (server).
 *
 * Three routes reach this — creating a chat, posting a message and retrying a failed turn — and
 * what they share is not merely the enqueue but what has to be true on both sides of it. The turn
 * is `QUEUED` with its `queueJobId` set to its own id before the job goes out, so a request that
 * is retried at the transport level enqueues the same work once rather than twice; and if the
 * enqueue is rejected the turn is failed before the error propagates, because a `QUEUED` turn no
 * worker will ever see would spin the UI forever and hold the chat's single work slot against
 * every later message.
 *
 * Keeping it here rather than in one of the routes is what stops the second and third caller from
 * reproducing only the enqueue and quietly dropping the compensation.
 */
import { enqueueRunTurn } from '@agent-hangar/core';
import type { Turn } from '@agent-hangar/core';

import type { ServerContainer } from '../container';

import { NO_USAGE } from './guards';

/** Error recorded on a turn the queue refused, so nothing is left waiting on a job that is gone. */
export const ENQUEUE_FAILED = 'Could not enqueue the turn';

/**
 * Hands an already-claimed turn to the worker.
 *
 * @param container - The server container.
 * @param turn - The claimed turn.
 * @returns The same turn.
 * @throws Error Whatever the queue rejected with, after the turn was failed.
 */
export async function dispatchTurn(container: ServerContainer, turn: Turn): Promise<Turn> {
  await container.repos.turns.setStatus(turn.id, 'QUEUED', { queueJobId: turn.id });
  try {
    await enqueueRunTurn(container.queues.chatTurns, { turnId: turn.id });
  } catch (error) {
    await container.repos.turns.finish(turn.id, 'FAILED', NO_USAGE, ENQUEUE_FAILED);
    throw error;
  }
  return turn;
}
