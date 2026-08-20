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
 * The two are not the same operation, though, and the difference is the whole reason this module
 * exists. A chat and a message each mint a turn id nobody has used before, so there is nothing in
 * Redis under that id. Re-running an existing turn reuses its id, and Redis still holds both of
 * that id's leftovers: the finished BullMQ job, which retention keeps and which would silently
 * swallow the new dispatch, and the event stream, which still ends in the previous attempt's
 * terminal event. Neither is visible from Postgres, so a re-dispatch that ignored them would look
 * successful and do nothing. {@link redispatchTurn} clears both first; {@link dispatchTurn} does
 * not pay for either.
 */
import { enqueueRunTurn, releaseTerminalJob, turnEventsStreamKey } from '@agent-hangar/core';
import type { Turn } from '@agent-hangar/core';

import type { ServerContainer } from '../container';

import { NO_USAGE } from './guards';

/** Error recorded on a turn the queue refused, so nothing is left waiting on a job that is gone. */
export const ENQUEUE_FAILED = 'Could not enqueue the turn';

/**
 * Marks the turn `QUEUED`, runs the dispatch, and fails the turn if the dispatch is rejected.
 *
 * @param container - The server container.
 * @param turn - The claimed turn.
 * @param send - What actually hands the work over; anything it throws fails the turn first.
 * @returns The same turn.
 * @throws Error Whatever `send` rejected with, after the turn was failed.
 */
async function claimAndSend(
  container: ServerContainer,
  turn: Turn,
  send: () => Promise<unknown>,
): Promise<Turn> {
  await container.repos.turns.setStatus(turn.id, 'QUEUED', { queueJobId: turn.id });
  try {
    await send();
  } catch (error) {
    await container.repos.turns.finish(turn.id, 'FAILED', NO_USAGE, ENQUEUE_FAILED);
    throw error;
  }
  return turn;
}

/**
 * Hands a newly claimed turn to the worker.
 *
 * For a turn id that has never been dispatched, which is every turn a chat or a message creates.
 *
 * @param container - The server container.
 * @param turn - The claimed turn.
 * @returns The same turn.
 * @throws Error Whatever the queue rejected with, after the turn was failed.
 */
export function dispatchTurn(container: ServerContainer, turn: Turn): Promise<Turn> {
  return claimAndSend(container, turn, () =>
    enqueueRunTurn(container.queues.chatTurns, { turnId: turn.id }),
  );
}

/**
 * Hands an already-run turn to the worker again, erasing the previous attempt first.
 *
 * The order matters and is the opposite of intuition: the residue is cleared *inside* the
 * protected section, so a failure to clear it fails the turn rather than leaving it `QUEUED` with
 * nothing behind it. Releasing the retained job is what makes the enqueue take effect at all;
 * deleting the event stream is what stops the new attempt from replaying the old one's terminal
 * event to a client that joins without a resume point — which is every client that loaded the
 * failure from history.
 *
 * @param container - The server container.
 * @param turn - The turn being run again, already moved back to `QUEUED` by the repository.
 * @returns The same turn.
 * @throws Error Whatever Redis or the queue rejected with, after the turn was failed.
 */
export function redispatchTurn(container: ServerContainer, turn: Turn): Promise<Turn> {
  return claimAndSend(container, turn, async () => {
    await releaseTerminalJob(container.queues.chatTurns, turn.id);
    await container.redis.del(turnEventsStreamKey(turn.id));
    await enqueueRunTurn(container.queues.chatTurns, { turnId: turn.id });
  });
}
