/**
 * How a chat turn and a scheduled run end.
 *
 * Layer: service.
 *
 * The two write different rows — a `Turn`, a `JobRun` — but they end the same event stream, in the
 * same shape, with the same error text, and they face the same four questions: what a failure
 * looks like, what a cancellation looks like, which of the two a delivery that was stopped *and*
 * was going nowhere records, and what happens when the delivery ends having recorded neither.
 * Answering those in one file is what keeps the UI reading one vocabulary whichever kind of run it
 * is watching, and stops a failure code drifting between the two.
 *
 * Nothing here decides *whether* a run has ended — that belongs to the processor that was driving
 * it. These are the writers it calls once it has decided.
 */
import { describeClientFailure, isTerminalRunStatus } from '@agent-hangar/core';
import type { AgentEvent } from '@agent-hangar/core';

import type { CancellationWatch } from './cancellation.js';
import { NO_USAGE, WORKER_ERROR_PREFIX } from './constants.js';
import { redactAgentEvent } from './turn-executor.js';
import type { UnreportedOutcome } from './turn-executor.js';
import type { ProcessorDeps } from './types.js';

/** What a turn's error says when its delivery ended before anything recorded an outcome. */
const UNREPORTED_TURN_MESSAGE = 'the worker stopped before the turn finished';

/**
 * Renders a failure as the text an `error` column carries.
 *
 * @param code - Machine-readable failure code.
 * @param message - Human-readable detail.
 * @returns The combined text.
 */
export function formatRunError(code: string, message: string): string {
  return `${code}: ${message}`;
}

/**
 * Ends a run's event stream with the failure the runtime did not report itself.
 *
 * @param deps - Publisher and redactor.
 * @param runId - `Turn.id` or `JobRun.id`.
 * @param code - Machine-readable failure code.
 * @param message - Human-readable detail.
 */
export async function publishFailure(
  deps: ProcessorDeps,
  runId: string,
  code: string,
  message: string,
): Promise<void> {
  const event: AgentEvent = { type: 'turn.failed', error: { code, message } };
  await deps.publisher.publish(runId, redactAgentEvent(deps.redactor, event));
}

/**
 * Ends a run's event stream with a cancellation the runtime never acknowledged.
 *
 * @param deps - Publisher and redactor.
 * @param runId - `Turn.id` or `JobRun.id`.
 */
export async function publishCancellation(deps: ProcessorDeps, runId: string): Promise<void> {
  const event: AgentEvent = { type: 'turn.cancelled' };
  await deps.publisher.publish(runId, redactAgentEvent(deps.redactor, event));
}

/**
 * Records a run as failed and ends its event stream.
 *
 * @param deps - Publisher and repositories.
 * @param runId - The run.
 * @param code - Machine-readable failure code.
 * @param message - Human-readable detail; already safe to persist.
 */
export async function failRun(
  deps: ProcessorDeps,
  runId: string,
  code: string,
  message: string,
): Promise<void> {
  await publishFailure(deps, runId, code, message);
  await deps.repos.jobRuns.finish(runId, {
    status: 'FAILED',
    usage: NO_USAGE,
    error: formatRunError(code, message),
  });
}

/**
 * Records a run as cancelled and ends its event stream.
 *
 * @param deps - Publisher and repositories.
 * @param runId - The run.
 */
export async function cancelRun(deps: ProcessorDeps, runId: string): Promise<void> {
  await publishCancellation(deps, runId);
  await deps.repos.jobRuns.finish(runId, { status: 'CANCELLED', usage: NO_USAGE });
}

/**
 * Ends a run that never started: as the cancellation the user asked for when one arrived, and
 * otherwise as the failure that made the delivery unrunnable.
 *
 * Both facts can hold of the same delivery. The user pressed Stop — and `POST /api/runs/:id/cancel`
 * answered `202`, which is a promise about this very row — while the delivery was independently
 * going nowhere: the job was deleted, the job was disabled, the previous run is still executing, or
 * the workspace could not be provisioned. Only one record gets written, and it is `CANCELLED`.
 *
 * The case for `FAILED` is not empty: the run could not have proceeded whatever the user did, and
 * the reason is operationally interesting. It loses on two counts. The `202` told the browser this
 * run was being stopped, so a row that then reads `FAILED` makes the API a liar about the one thing
 * the user was waiting to see. And the reason is not lost by cancelling — the worker log already
 * carries it, addressed to the operator who wants it, and a provisioning failure has written itself
 * onto the workspace row as well. What `FAILED` would lose is the user's own instruction, which
 * nothing else records anywhere.
 *
 * Either way exactly one terminal event goes out, published before the row is finished: the manual
 * run's browser is attached to that stream, and a run that ends without a terminal event leaves the
 * page waiting for something nobody is going to send.
 *
 * @param deps - Publisher and repositories.
 * @param runId - The run.
 * @param watch - The run's own cancellation subscription.
 * @param code - Machine-readable failure code, recorded when no cancellation arrived.
 * @param message - Human-readable detail, recorded when no cancellation arrived.
 */
export async function endUnstartedRun(
  deps: ProcessorDeps,
  runId: string,
  watch: CancellationWatch,
  code: string,
  message: string,
): Promise<void> {
  if (watch.requested()) {
    await cancelRun(deps, runId);
    return;
  }
  await failRun(deps, runId, code, message);
}

/**
 * Records a turn as failed and tells the UI why.
 *
 * @param deps - Publisher and repositories.
 * @param turnId - The turn.
 * @param code - Machine-readable failure code.
 * @param message - Human-readable detail; already safe to persist.
 */
export async function failTurn(
  deps: ProcessorDeps,
  turnId: string,
  code: string,
  message: string,
): Promise<void> {
  await publishFailure(deps, turnId, code, message);
  await deps.repos.turns.finish(turnId, 'FAILED', NO_USAGE, formatRunError(code, message));
}
/**
 * Writes the outcome for a turn whose runtime never reported one.
 *
 * A cancellation that the runtime did not acknowledge is still a cancellation: the user asked for
 * it and the exec is over. Everything else is a failure.
 *
 * @param deps - Publisher and repositories.
 * @param turnId - The turn.
 * @param outcome - What the executor observed.
 */
export async function closeOutTurn(
  deps: ProcessorDeps,
  turnId: string,
  outcome: UnreportedOutcome,
): Promise<void> {
  if (outcome.terminal === 'cancelled') {
    await publishCancellation(deps, turnId);
    await deps.repos.turns.finish(turnId, 'CANCELLED', NO_USAGE);
    return;
  }
  await failTurn(deps, turnId, outcome.error.code, outcome.error.message);
}

/**
 * Records a turn the user stopped before its exec began.
 *
 * The workspace is left as it is: nothing ran in it, so the next message reuses it.
 *
 * @param deps - Publisher and repositories.
 * @param turnId - The turn.
 */
export async function cancelBeforeStart(deps: ProcessorDeps, turnId: string): Promise<void> {
  await publishCancellation(deps, turnId);
  await deps.repos.turns.finish(turnId, 'CANCELLED', NO_USAGE);
}

/**
 * Ends a turn that never started: as the cancellation the user asked for when one arrived, and
 * otherwise as the reason the turn could not begin.
 *
 * Both facts can hold of the same delivery. The user pressed Stop — and `POST /api/turns/:id/cancel`
 * answered `202`, which is a promise about this very row — while the turn was independently going
 * nowhere: its chat was deleted, another turn of the chat holds the workspace, or the workspace
 * could not be prepared. Only one record gets written, and it is `CANCELLED`.
 *
 * The case for `FAILED` is that the turn could not have proceeded whatever the user did, and the
 * reason is worth keeping. It loses the same way it loses for a scheduled run: the `202` told the
 * browser this turn was being stopped, so a row that then reads `FAILED` contradicts the answer the
 * user already has, while the user's own instruction is recorded nowhere else. The conflict message
 * makes it sharper still — it asks the user to send the message again, which is the opposite of
 * what somebody who has just pressed Stop wants to read.
 *
 * Most of these reasons survive the choice: a deleted chat and a lost claim are both on the worker
 * log, and a provisioning failure has written itself onto the workspace row with its reason. One
 * does not — a repository the operator has removed from the allow-list is refused before any row
 * exists and without a log line of its own, so cancelling drops that detail. Accepted knowingly:
 * the operator made that removal deliberately and the user asked for this turn to stop, so neither
 * of them learns anything from a turn row they were never going to read.
 *
 * Either way exactly one terminal event goes out, published before the row is finished, and none of
 * these paths reaches the step that settles a turn which did run, so no turn is finished twice.
 *
 * @param deps - Publisher and repositories.
 * @param turnId - The turn.
 * @param watch - The turn's cancellation subscription, open since before the first row was read.
 * @param code - Machine-readable failure code, recorded when no cancellation arrived.
 * @param message - Human-readable detail, recorded when no cancellation arrived.
 */
export async function endUnstartedTurn(
  deps: ProcessorDeps,
  turnId: string,
  watch: CancellationWatch,
  code: string,
  message: string,
): Promise<void> {
  if (watch.requested()) {
    await cancelBeforeStart(deps, turnId);
    return;
  }
  await failTurn(deps, turnId, code, message);
}

/**
 * Records a turn its delivery ended without an outcome, so no turn ends in silence.
 *
 * A rejected job is how the operator learns the Docker daemon is down, and rejecting is right. What
 * it must not also do is leave the turn open: nothing redelivers this job — `attempts` defaults to
 * zero, no producer sets it and no default job options are declared — so a turn left `PREPARING`
 * stays `PREPARING`, with an empty event stream and a page waiting for a terminal event that is
 * never coming. Measured before this existed, for an unreachable daemon at container-create time:
 * status `PREPARING`, error `null`, no events at all.
 *
 * The row is read first because most failures have already written their own outcome, and the
 * one the runtime reported is the one the user is owed. This is the net under the rest, not a
 * second opinion about them: it writes only when nothing else did.
 *
 * It never throws. The caller is on its way to rethrowing the failure that brought it here, and
 * that failure is the one the operator has to see — a net that replaced it with its own would
 * report Postgres being unreachable for a turn that stopped because Docker was. The reason a
 * write here fails is almost always the same outage as the reason there is a turn to close, so
 * the second failure is described into the log and the first one is left to travel.
 *
 * @param deps - Publisher, repositories and logger.
 * @param turnId - The turn the delivery was about.
 */
export async function endUnreportedTurn(deps: ProcessorDeps, turnId: string): Promise<void> {
  try {
    const turn = await deps.repos.turns.get(turnId);
    if (turn === null || isTerminalRunStatus(turn.status)) {
      return;
    }
    await failTurn(deps, turnId, WORKER_ERROR_PREFIX, UNREPORTED_TURN_MESSAGE);
  } catch (error) {
    // Described rather than logged whole: a driver builds its message from the connection string
    // it was configured with, password included.
    deps.logger.error(
      { failure: describeClientFailure(error), turnId },
      'recording the outcome of a turn its delivery never finished failed',
    );
  }
}
