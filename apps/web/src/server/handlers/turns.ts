/**
 * Turn cancellation.
 *
 * Layer: service (server).
 *
 * Cancelling has two shapes, and which one applies depends on whether the worker has picked the
 * turn up (`./cancel.ts` holds the half of that decision both cancel routes share). A job still
 * waiting in the queue is removed and the turn is closed here, which is exact and immediate. A turn
 * already executing lives in a container the worker owns, so the web process only publishes the
 * request on the command channel and answers `202`; the worker signals the process group and
 * persists the terminal status.
 *
 * The first shape spans Redis and Postgres, which cannot enlist in one transaction, so the two
 * writes are kept in agreement by compensation: the job is removed, the terminal status is written,
 * and a write that fails puts the job back. Neither ordering is safe on its own here — removing
 * first and failing to persist leaves a row that says `QUEUED` with nothing behind it to run, while
 * persisting first and failing to remove leaves a job the worker would start for a turn already
 * recorded as cancelled. Compensation is what the ordering cannot give, and it restores the exact
 * previous state rather than an approximation of it: the BullMQ job id is the turn id, so the
 * re-enqueue recreates the same job, with the same payload and the same retention, and the only
 * difference is that it rejoins the queue at the back rather than at its former position.
 *
 * The guarantee stops where the compensating enqueue also fails. The turn is then `QUEUED` with no
 * job behind it, the request still fails with the error that explains it, and the log line
 * `compensate` writes, naming the turn, is the only record; cancelling that turn again answers
 * `202` and publishes a command no worker is listening for, so it takes an operator to close it.
 *
 * This route answers for chat turns only. Its parameter is resolved through the turn repository,
 * so a `JobRun.id` is a 404 here rather than a cancellation of the wrong kind of work; stopping a
 * scheduled run is `handlers/runs.ts`'s `cancelRun`.
 */
import { enqueueRunTurn, okResponse, turnCommand, turnCommandChannel } from '@agent-hangar/core';

import type { ServerContainer } from '../container';
import { ConflictError, ResourceNotFoundError } from '../errors';
import { jsonResponse, withErrorHandling } from '../http';
import { assertSameOrigin } from '../same-origin';

import { CANCEL_REQUESTED_STATUS, removeQueuedJob } from './cancel';
import { compensate } from './compensate';
import { NO_USAGE } from './guards';

/** Statuses a turn can no longer leave. */
const TERMINAL_STATUSES: readonly string[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

/** Path parameters of the cancel route. */
export interface TurnParams {
  id: string;
}

/**
 * `POST /api/turns/:id/cancel` — stops a turn, before or during execution.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @param params - Resolved path parameters.
 * @returns `200` when the turn was cancelled outright, `202` when the worker was asked to stop it.
 * @throws Error When the terminal status could not be written after the job was removed; the job
 *   is put back first, so a retry of the request finds the same state it started from.
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
    if (turn.status === 'QUEUED' && (await removeQueuedJob(container.queues.chatTurns, turn.id))) {
      try {
        await container.repos.turns.finish(turn.id, 'CANCELLED', NO_USAGE);
      } catch (error) {
        await compensate(
          container,
          { turnId: turn.id },
          'could not undo a partial turn cancel',
          () => enqueueRunTurn(container.queues.chatTurns, { turnId: turn.id }),
        );
        throw error;
      }
      return jsonResponse(okResponse, { ok: true });
    }
    await container.redis.publish(
      turnCommandChannel(turn.id),
      JSON.stringify(turnCommand.parse({ type: 'cancel' })),
    );
    return jsonResponse(okResponse, { ok: true }, { status: CANCEL_REQUESTED_STATUS });
  });
}
