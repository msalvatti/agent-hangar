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
 * A `202` is a promise about the row, not only about the message that was sent. The web process
 * takes the turn `CANCELLED` itself — conditionally, so it is granted only while the turn is still
 * live — and answers `202` only once that write has landed. `./cancel.ts` holds that step and the
 * argument for it; what it costs *here* is a turn stopped in the instant it was succeeding: the
 * answer is still appended to the transcript, but the row reads `CANCELLED`, because that is what
 * the user asked for and what they were told.
 *
 * The same trade reaches the live event stream, and in the same direction. The worker publishes a
 * turn's terminal event before it persists the outcome, so a page watching the stream at that exact
 * moment can be shown the `turn.completed` or `turn.failed` the worker was about to write while the
 * row already says `CANCELLED`. Nothing republishes to correct it, deliberately: the stream is a
 * live view of what the container did, the row is the record of what the turn *is*, and every
 * reader that outlives the stream — a reload, the sidebar, the retry route — reads the row. Making
 * the two agree would mean either publishing a second terminal event, which the transcript reducer
 * would render as a second ending, or holding the stream back until the write settled, which would
 * delay the one thing the user is watching for.
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
import { enqueueRunTurn, isTerminalRunStatus, okResponse } from '@agent-hangar/core';
import type { Turn } from '@agent-hangar/core';

import type { ServerContainer } from '../container';
import { ConflictError, ResourceNotFoundError } from '../errors';
import { jsonResponse, withErrorHandling } from '../http';
import { assertSameOrigin } from '../same-origin';

import { askWorkerToCancel, removeQueuedJob } from './cancel';
import { compensate } from './compensate';
import { redispatchTurn, releasePreviousAttempt } from './dispatch';
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

/** Why a turn that is no longer the chat's most recent one is not run again. */
const RETRY_SUPERSEDED =
  'A later turn has superseded this one; only the most recent turn can be retried';

/** What a caller is told when the turn it named has already reached an outcome. */
const TURN_ALREADY_FINISHED = 'This turn has already finished';

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
 * @throws ConflictError 409 `TURN_NOT_CANCELLABLE` when the turn had already finished, whether it
 *   was already finished when this request read it or finished while the request was in flight.
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
    // Read first only to answer a finished turn without touching the queue; the write below is
    // what actually decides, and it re-tests this on the row rather than trusting the snapshot.
    if (isTerminalRunStatus(turn.status)) {
      throw new ConflictError('TURN_NOT_CANCELLABLE', TURN_ALREADY_FINISHED);
    }
    if (turn.status === 'QUEUED' && (await removeQueuedJob(container.queues.chatTurns, turn.id))) {
      let cancelled: Turn | null;
      try {
        cancelled = await container.repos.turns.finish(turn.id, 'CANCELLED', NO_USAGE);
      } catch (error) {
        await compensate(
          container,
          { turnId: turn.id },
          'could not undo a partial turn cancel',
          () => enqueueRunTurn(container.queues.chatTurns, { turnId: turn.id }),
        );
        throw error;
      }
      // Losing here is not a half-done cancel to undo: the turn already carries an outcome, so
      // there is no work left for the job that was taken off the queue to do.
      if (cancelled === null) {
        throw new ConflictError('TURN_NOT_CANCELLABLE', TURN_ALREADY_FINISHED);
      }
      return jsonResponse(okResponse, { ok: true });
    }
    return askWorkerToCancel(container, {
      id: turn.id,
      finish: () => container.repos.turns.finish(turn.id, 'CANCELLED', NO_USAGE),
      code: 'TURN_NOT_CANCELLABLE',
      message: TURN_ALREADY_FINISHED,
    });
  });
}

/**
 * Resolves the turn a retry names and decides whether it may run again.
 *
 * Every refusal here is read-only, so a request that gets one has changed nothing. The order is
 * chosen for what the caller can do next: a chat that is gone or archived first, then work that is
 * still under way — `TURN_IN_PROGRESS` tells them to wait or cancel — then the two "this is not the
 * turn to retry" answers, which share a code because they are one rule seen from two sides.
 *
 * @param container - The server container.
 * @param turnId - Turn named by the route.
 * @returns The turn, once it is established that it may be run again.
 * @throws ResourceNotFoundError 404 when the turn, or the chat behind it, does not exist.
 * @throws ConflictError 409 `CHAT_ARCHIVED`, `TURN_IN_PROGRESS` or `TURN_NOT_RETRYABLE`.
 */
async function requireRetryableTurn(container: ServerContainer, turnId: string): Promise<Turn> {
  const turn = await container.repos.turns.get(turnId);
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
  const turns = await container.repos.turns.listByChat(turn.chatId);
  if (turns.at(-1)?.id !== turn.id) {
    throw new ConflictError('TURN_NOT_RETRYABLE', RETRY_SUPERSEDED);
  }
  if (turn.status !== 'FAILED') {
    throw new ConflictError('TURN_NOT_RETRYABLE', RETRY_REFUSED);
  }
  return turn;
}

/**
 * `POST /api/turns/:id/retry` — runs a failed turn again, against the prompt already attached to
 * it.
 *
 * Only the chat's most recent turn may be run again, and only when it failed. The "most recent"
 * half is not a nicety: the events route streams `turns.at(-1)`, the sidebar dot and the
 * transcript's phase both read it, and the worker rebuilds its context from the chat's whole
 * message history. Re-running an older row would therefore answer the newest prompt while the
 * client followed a different turn, and record the result against one nobody is looking at. In a
 * linear chat there is no coherent meaning for "run the third turn again"; the way to ask an
 * earlier question again is to ask it again.
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
 * Before any of that, the previous attempt has to be over. The worker records a turn's outcome
 * before its processor returns, so a Retry can arrive while the row already reads `FAILED` and its
 * BullMQ job is still `active` — and enqueuing there is answered with the running job, leaving a
 * `QUEUED` turn nothing will ever pick up. That case is refused rather than absorbed; see
 * `handlers/dispatch.ts`.
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
    const turn = await requireRetryableTurn(container, params.id);
    await requireSecrets(container);
    await releasePreviousAttempt(container, turn.id);
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
    await redispatchTurn(container, requeued);
    return jsonResponse(okResponse, { ok: true });
  });
}
