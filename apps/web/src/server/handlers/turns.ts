/**
 * Turn cancellation and turn retry.
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
 *
 * Retrying is the other direction and shares the same resolution. It re-dispatches the turn row
 * that failed rather than opening a new one, and it appends no message: the prompt the turn ran on
 * is already persisted and already points at this turn, so re-running it is the only reading of
 * "try that again" that leaves the transcript agreeing with the database. Opening a second turn
 * would need a second prompt to hang it from — the transcript pairs a turn's tool calls with the
 * USER message whose `turnId` matches — which is precisely the duplicate this route exists to
 * avoid. The cost is that the row keeps no history of its attempts: the failure that preceded the
 * retry survives only in the log, and Postgres cannot answer how often a turn was run.
 */
import { enqueueRunTurn, okResponse, turnCommand, turnCommandChannel } from '@agent-hangar/core';

import type { ServerContainer } from '../container';
import { ConflictError, ResourceNotFoundError } from '../errors';
import { jsonResponse, withErrorHandling } from '../http';
import { assertSameOrigin } from '../same-origin';

import { CANCEL_REQUESTED_STATUS, removeQueuedJob } from './cancel';
import { compensate } from './compensate';
import { dispatchTurn } from './dispatch';
import {
  CLAIM_RELEASED,
  NO_USAGE,
  requireNoLiveTurn,
  requireSecrets,
  requireSoleClaim,
  requireStillActive,
} from './guards';

/** Why a turn that did not fail is not run again; one sentence for both ways of reaching it. */
const RETRY_REFUSED = 'Only a failed turn can be retried; send the prompt again to start a new one';

/** Statuses a turn can no longer leave. */
const TERMINAL_STATUSES: readonly string[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

/** Path parameters of the turn routes. */
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

/**
 * `POST /api/turns/:id/retry` — runs a failed turn again, against the prompt already attached to
 * it.
 *
 * `FAILED` is the only status this accepts, and the two near misses are refused on purpose.
 * `CANCELLED` is a decision the user made — Stop was pressed — and re-running it silently would
 * undo that decision rather than recover from an accident; the way to run a cancelled prompt again
 * is to send it, which records a new intent where the transcript can show it. `SUCCEEDED` would
 * hang a second answer off a prompt that already has one, leaving a transcript no reader can
 * account for. Both answer `TURN_NOT_RETRYABLE`, so "no" is a stated outcome the UI can render
 * rather than the absence of an effect.
 *
 * The order of the checks decides which "no" a caller hears, and it is chosen for what the caller
 * can do next. A turn that is still live is reported as `TURN_IN_PROGRESS` by the same guard the
 * message route uses — "wait for it or cancel it" is actionable, where "not retryable" would only
 * be true for the moment. Credentials are checked before anything is written, so a chat is never
 * left with a queued turn that could not have run.
 *
 * The state change and its precondition are one write: `requeue` names `FAILED` in its own `where`
 * clause, so two retries of the same turn arriving together cannot both find it failed and both
 * proceed. The loser is answered `TURN_NOT_RETRYABLE`, which is what its turn now is.
 *
 * That settles two retries of one turn; it does not settle a retry racing a *different* request on
 * the same chat, which is a chat-wide invariant rather than a row-level one. Making the turn
 * `QUEUED` is this route's claim on the chat's single work slot, so — exactly as a message does —
 * it re-reads both the chat's turns and the chat's status *after* that write, and gives the claim
 * back to `FAILED` if either has moved. Checking only beforehand would let a message insert its own
 * turn in the window, or an archive commit its status write, and leave the chat with two live turns
 * or with a teardown queued under running work. `handlers/guards.ts` carries the ordering argument
 * and both halves of the check.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @param params - Resolved path parameters.
 * @returns `200` with `{ ok: true }` once the turn is back on the queue.
 * @throws Error Whatever the queue rejected with; the turn is marked `FAILED` again first, so it
 *   is left exactly as retryable as it was before the request.
 */
export function retryTurn(
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
    const chat = await container.repos.chats.getById(turn.chatId);
    if (chat === null) {
      throw new ResourceNotFoundError('Chat not found');
    }
    if (chat.status !== 'ACTIVE') {
      throw new ConflictError('CHAT_ARCHIVED', 'Restore the chat before retrying the turn');
    }
    await requireNoLiveTurn(container, turn.chatId);
    if (turn.status !== 'FAILED') {
      throw new ConflictError('TURN_NOT_RETRYABLE', RETRY_REFUSED);
    }
    await requireSecrets(container);
    const requeued = await container.repos.turns.requeue(turn.id);
    if (requeued === null) {
      throw new ConflictError('TURN_NOT_RETRYABLE', RETRY_REFUSED);
    }
    try {
      await requireSoleClaim(container, turn.chatId, turn.id);
      await requireStillActive(container, turn.chatId);
      await container.repos.chats.touch(turn.chatId);
    } catch (error) {
      await compensate(
        container,
        { chatId: turn.chatId, turnId: turn.id },
        'could not release a retried turn claim',
        () => container.repos.turns.finish(turn.id, 'FAILED', NO_USAGE, CLAIM_RELEASED),
      );
      throw error;
    }
    await dispatchTurn(container, requeued);
    return jsonResponse(okResponse, { ok: true });
  });
}
