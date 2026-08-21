/**
 * Run history, run detail and run cancellation.
 *
 * Layer: service (server).
 *
 * The two reads carry no same-origin guard: a cross-origin page cannot read the response, and the
 * browser is what enforces that. Cancel changes state, so it carries the guard like every other
 * write.
 *
 * Cancel is the run's own route rather than a second meaning for the chat one. Both kinds of work
 * are stopped by the same mechanism — the queued job is removed, or the request is published on
 * `cmd:turn:<id>` for the worker that holds the container — but they are addressed by ids from
 * different tables, and a route that had to guess which table it was handed would answer the wrong
 * `404` whenever a lookup missed for some other reason. Each id is resolved by the repository that
 * owns it: a `Turn.id` here is a `404`, exactly as a `JobRun.id` is at `/api/turns/:id/cancel`.
 *
 * A run this process can still take off the queue is closed here outright. Once the worker has
 * taken the delivery, this route publishes the request — and then takes the run terminal itself,
 * conditionally, so a `202` is a promise about the row rather than only about the message. The
 * scheduled-job processor's cancellation subscription is already open by the time that publish
 * could arrive: for a manual run, whose id exists before it is ever enqueued (the row this route
 * reads is created first), the worker subscribes before it reads anything of its own; for a
 * scheduled tick, whose id does not exist until the worker creates its row, the subscription opens
 * the instant that row does, which is the earliest a subscriber could possibly exist. So the
 * publish always reaches a listener already in place — but reaching one was never enough on its
 * own, and `./cancel.ts` holds the step that makes the `202` a promise about the row and the
 * argument for it.
 *
 * Two prices, named rather than hidden. A run recorded `CANCELLED` while its container is still
 * being torn down no longer counts as the overlapping run a fresh tick backs off from, so a tick
 * landing in those seconds starts a second workspace instead of skipping — one extra container for
 * the length of a teardown that is already under way, against a run whose recorded outcome
 * contradicts the answer its user was given. And the worker publishes a run's terminal event before
 * it persists the outcome, so a drawer watching the stream at that moment can be shown the
 * `turn.completed` or `turn.failed` the worker was about to write while the row already says
 * `CANCELLED`. Nothing republishes to correct it: the stream is a live view of what the container
 * did, the row is the record of what the run *is*, and every reader that outlives the stream reads
 * the row.
 */
import { isTerminalRunStatus, listRunsResponse, okResponse } from '@agent-hangar/core';
import type { JobRun } from '@agent-hangar/core';

import type { ServerContainer } from '../container';
import { ConflictError, ResourceNotFoundError } from '../errors';
import { json, jsonResponse, withErrorHandling } from '../http';
import { assertSameOrigin } from '../same-origin';

import { askWorkerToCancel, removeQueuedJob } from './cancel';
import { compensate } from './compensate';
import { NO_USAGE } from './guards';
import { enqueueManualRun } from './manual-run';
import { toRunDetail, toRunSummary } from './mappers';

/**
 * How many runs the history returns.
 *
 * The contract declares no paging for this route, so the page size is a server decision rather
 * than a query parameter no client could send. Fifty rows cover the table the UI renders.
 */
export const RUNS_PAGE_SIZE = 50;

/** What a caller is told when the run it named has already reached an outcome. */
const RUN_ALREADY_FINISHED = 'This run has already finished';

/** Path parameters of the run routes. */
export interface RunParams {
  id: string;
}

/**
 * `GET /api/jobs/:id/runs` — the run history of one job, newest first.
 *
 * @param container - The server container.
 * @param _request - The incoming request; this route reads nothing from it.
 * @param params - Resolved path parameters (the job id).
 * @returns `200` with the run summaries, or `404` when the job is unknown.
 */
export function listRuns(
  container: ServerContainer,
  _request: Request,
  params: RunParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    if ((await container.repos.scheduledJobs.get(params.id)) === null) {
      throw new ResourceNotFoundError('Scheduled job not found');
    }
    const runs = await container.repos.jobRuns.listByJob(params.id, { limit: RUNS_PAGE_SIZE });
    return jsonResponse(listRunsResponse, { runs: runs.map(toRunSummary) });
  });
}

/**
 * `GET /api/runs/:id` — one run with its output and tool calls.
 *
 * @param container - The server container.
 * @param _request - The incoming request; this route reads nothing from it.
 * @param params - Resolved path parameters (the run id).
 * @returns `200` with the run detail, or `404`.
 */
export function getRun(
  container: ServerContainer,
  _request: Request,
  params: RunParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    const run = await container.repos.jobRuns.get(params.id);
    if (run === null) {
      throw new ResourceNotFoundError('Run not found');
    }
    const toolCalls = await container.repos.toolCalls.listByJobRun(run.id);
    // The mapper already parsed the value against `runDetail`.
    return json(toRunDetail(run, toolCalls));
  });
}

/**
 * `POST /api/runs/:id/cancel` — stops a scheduled-job run, before or during execution.
 *
 * The queued shape spans Redis and Postgres, which cannot enlist in one transaction, so the two
 * writes are kept in agreement by compensation exactly as the chat path keeps them: the delivery is
 * removed, the terminal status is written, and a write that fails puts the delivery back under the
 * same job id, with the same payload and the same retention. Removing first and failing to persist
 * would leave a row reading `QUEUED` with nothing behind it to run; persisting first and failing to
 * remove would leave a delivery the worker starts for a run already recorded as cancelled. Only a
 * manual run can reach that branch — it is the only kind whose BullMQ job id is its run id — so the
 * delivery that goes back is always the one that was taken away, never one invented for a tick.
 *
 * That guarantee stops where the compensating enqueue also fails: the run is then `QUEUED` with no
 * delivery behind it, the request fails with the error that explains it, and the log line
 * `compensate` writes is the only record. Cancelling it again answers `202` and publishes a command
 * no worker is listening for, so it takes an operator to close it.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @param params - Resolved path parameters (the run id).
 * @returns `200` when the run was cancelled outright, `202` when the worker was asked to stop it.
 * @throws ConflictError 409 `RUN_NOT_CANCELLABLE` when the run had already finished, whether it was
 *   already finished when this request read it or finished while the request was in flight.
 * @throws Error When the terminal status could not be written after the delivery was removed; the
 *   delivery is put back first, so a retry of the request finds the same state it started from.
 */
export function cancelRun(
  container: ServerContainer,
  request: Request,
  params: RunParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertSameOrigin(request);
    const run = await container.repos.jobRuns.get(params.id);
    if (run === null) {
      throw new ResourceNotFoundError('Run not found');
    }
    // Read first only to answer a finished run without touching the queue; the write below is
    // what actually decides, and it re-tests this on the row rather than trusting the snapshot.
    if (isTerminalRunStatus(run.status)) {
      throw new ConflictError('RUN_NOT_CANCELLABLE', RUN_ALREADY_FINISHED);
    }
    if (
      run.status === 'QUEUED' &&
      (await removeQueuedJob(container.queues.scheduledJobs, run.id))
    ) {
      let cancelled: JobRun | null;
      try {
        cancelled = await container.repos.jobRuns.finish(run.id, {
          status: 'CANCELLED',
          usage: NO_USAGE,
        });
      } catch (error) {
        await compensate(container, { runId: run.id }, 'could not undo a partial run cancel', () =>
          enqueueManualRun(container.queues.scheduledJobs, { jobId: run.jobId, runId: run.id }),
        );
        throw error;
      }
      // Losing here is not a half-done cancel to undo: the run already carries an outcome, so the
      // delivery that was taken off the queue has nothing left to do.
      if (cancelled === null) {
        throw new ConflictError('RUN_NOT_CANCELLABLE', RUN_ALREADY_FINISHED);
      }
      return jsonResponse(okResponse, { ok: true });
    }
    return askWorkerToCancel(container, {
      id: run.id,
      finish: () =>
        container.repos.jobRuns.finish(run.id, { status: 'CANCELLED', usage: NO_USAGE }),
      code: 'RUN_NOT_CANCELLABLE',
      message: RUN_ALREADY_FINISHED,
    });
  });
}
