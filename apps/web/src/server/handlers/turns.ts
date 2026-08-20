/**
 * Turn cancellation.
 *
 * Layer: service (server).
 *
 * Cancelling has two shapes, and which one applies depends on whether the worker has picked the
 * turn up. A job still waiting in the queue is removed and the turn is closed here, which is exact
 * and immediate. A turn already executing lives in a container the worker owns, so the web process
 * only publishes the request on the command channel and answers `202`; the worker signals the
 * process group and persists the terminal status.
 */
import { okResponse, turnCommand, turnCommandChannel } from '@agent-hangar/core';
import type { Turn } from '@agent-hangar/core';

import type { ServerContainer } from '../container';
import { ConflictError, ResourceNotFoundError } from '../errors';
import { jsonResponse, withErrorHandling } from '../http';
import { assertSameOrigin } from '../same-origin';

import { NO_USAGE } from './guards';

/** Status the cancel request is accepted with when the worker still has to act on it. */
export const CANCEL_REQUESTED_STATUS = 202;

/** BullMQ states in which a job has not started and can still be removed. */
const REMOVABLE_STATES: readonly string[] = ['waiting', 'delayed', 'prioritized'];

/** Statuses a turn can no longer leave. */
const TERMINAL_STATUSES: readonly string[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

/** Path parameters of the cancel route. */
export interface TurnParams {
  id: string;
}

/**
 * Removes the queued job of a turn, when it is still removable.
 *
 * The state is read and then acted on, and nothing holds the queue still in between: BullMQ can
 * hand the job to a worker after the check, and it refuses to remove a job a worker has locked.
 * That refusal is the running case rather than a failure — the same situation the caller already
 * handles for a job that was active when it was checked — so the state is read again to tell the
 * two apart. A removal that fails while the job is still removable is a failure of the store and
 * is reported as one.
 *
 * @param container - The server container.
 * @param turn - The turn being cancelled.
 * @returns `true` when the job was removed before it started.
 * @throws Error When the queue refuses the removal for any reason other than the job having
 *   started.
 */
async function removeQueuedJob(container: ServerContainer, turn: Turn): Promise<boolean> {
  const job = await container.queues.chatTurns.getJob(turn.id);
  if (job === undefined || !REMOVABLE_STATES.includes(await job.getState())) {
    return false;
  }
  try {
    await job.remove();
  } catch (error) {
    if (REMOVABLE_STATES.includes(await job.getState())) {
      throw error;
    }
    return false;
  }
  return true;
}

/**
 * `POST /api/turns/:id/cancel` — stops a turn, before or during execution.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @param params - Resolved path parameters.
 * @returns `200` when the turn was cancelled outright, `202` when the worker was asked to stop it.
 */
export function cancelTurn(
  container: ServerContainer,
  request: Request,
  params: TurnParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertSameOrigin(request);
    const turn = await container.repos.turns.get(params.id);
    if (turn === null) {
      throw new ResourceNotFoundError('Turn not found');
    }
    if (TERMINAL_STATUSES.includes(turn.status)) {
      throw new ConflictError('TURN_NOT_CANCELLABLE', 'This turn has already finished');
    }
    if (turn.status === 'QUEUED' && (await removeQueuedJob(container, turn))) {
      await container.repos.turns.finish(turn.id, 'CANCELLED', NO_USAGE);
      return jsonResponse(okResponse, { ok: true });
    }
    await container.redis.publish(
      turnCommandChannel(turn.id),
      JSON.stringify(turnCommand.parse({ type: 'cancel' })),
    );
    return jsonResponse(okResponse, { ok: true }, { status: CANCEL_REQUESTED_STATUS });
  });
}
