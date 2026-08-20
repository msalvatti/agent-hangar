/** @vitest-environment node */
/**
 * Unit tests for the run history, run detail and run cancellation routes.
 *
 * Layer: unit.
 * Goal: the history is bounded and newest-first, the detail carries the output and the tool calls,
 * an unknown job or run is reported as missing rather than as an empty list, and a run is stopped
 * by the same two shapes the chat path uses — the delivery removed before it starts, or the request
 * published for the worker that already holds it.
 * Mocks: the `bullmq` module.
 */
import { listRunsResponse, runDetail, turnCommand, turnCommandChannel } from '@agent-hangar/core';
import type { JobRun, ScheduledJob } from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import { foreignRequest, readRequest, writeRequest } from '../testing/requests';
import { createTestContainer } from '../testing/test-container';
import type { TestContainer } from '../testing/test-container';

import { triggerRun } from './jobs';
import { cancelRun, getRun, listRuns, RUNS_PAGE_SIZE } from './runs';

vi.mock('bullmq', () => import('../testing/fake-queue'));

/** Instant every container in this file starts from. */
const NOW = new Date('2026-08-19T10:00:00.000Z');

/**
 * Seeds a job with a number of runs.
 *
 * @param harness - The test container.
 * @param count - How many runs to create.
 * @returns The job id and the created runs, oldest first.
 */
async function seedRuns(
  harness: TestContainer,
  count: number,
): Promise<{ jobId: string; runs: JobRun[] }> {
  const job = await seedJob(harness);
  const runs: JobRun[] = [];
  for (let index = 0; index < count; index += 1) {
    harness.doubles.clock.advance(1000);
    runs.push(
      await harness.doubles.repos.jobRuns.create({
        jobId: job.id,
        trigger: 'SCHEDULE',
        model: 'gpt-test',
        scheduledFor: harness.doubles.clock.now(),
      }),
    );
  }
  return { jobId: job.id, runs };
}

/**
 * Creates a scheduled job.
 *
 * @param harness - The test container.
 * @returns The stored job.
 */
async function seedJob(harness: TestContainer): Promise<ScheduledJob> {
  return harness.doubles.repos.scheduledJobs.create({
    name: 'Nightly triage',
    cron: '0 3 * * *',
    timezone: 'Europe/Lisbon',
    prompt: 'Triage new issues',
    repoUrl: 'https://github.com/acme/widgets',
    branch: 'main',
    enabled: true,
  });
}

/**
 * Starts a manual run through the route that owns it, so the delivery on the queue is the one the
 * application really produces — job id included, which is what the cancel path looks the run up by.
 *
 * @param harness - The test container.
 * @returns The id of the created run.
 */
async function seedManualRun(harness: TestContainer): Promise<string> {
  const job = await seedJob(harness);
  const response = await triggerRun(
    harness.container,
    writeRequest(`/api/jobs/${job.id}/run`, 'POST'),
    { id: job.id },
  );
  const body = (await response.json()) as { runId: string };
  return body.runId;
}

/**
 * Builds a same-origin cancel request for a run.
 *
 * @param id - Run id.
 * @returns The request.
 */
function cancelRequest(id: string): Request {
  return writeRequest(`/api/runs/${id}/cancel`, 'POST');
}

describe('listRuns', () => {
  /**
   * The history is newest first, because the table's first row is the run the user just started.
   */
  it('lists the runs of a job, newest first', async () => {
    const harness = createTestContainer({ now: NOW });
    const { jobId, runs } = await seedRuns(harness, 3);
    const response = await listRuns(harness.container, readRequest(`/api/jobs/${jobId}/runs`), {
      id: jobId,
    });
    const body = listRunsResponse.parse(await response.json());
    expect(body.runs.map((run) => run.id)).toEqual([...runs].reverse().map((run) => run.id));
  });

  /**
   * The page is bounded: a job that has run every night for a year must not return a year of rows
   * to a table that shows the recent ones.
   */
  it('caps the history at one page', async () => {
    const harness = createTestContainer({ now: NOW });
    const { jobId } = await seedRuns(harness, RUNS_PAGE_SIZE + 5);
    const response = await listRuns(harness.container, readRequest(`/api/jobs/${jobId}/runs`), {
      id: jobId,
    });
    expect(listRunsResponse.parse(await response.json()).runs).toHaveLength(RUNS_PAGE_SIZE);
  });

  /**
   * An unknown job is missing rather than an empty history, which would look like a job that has
   * simply never run.
   */
  it('reports an unknown job as missing', async () => {
    const harness = createTestContainer({ now: NOW });
    const response = await listRuns(harness.container, readRequest('/api/jobs/nope/runs'), {
      id: 'nope',
    });
    expect(response.status).toBe(404);
  });
});

describe('getRun', () => {
  /**
   * The detail carries the final output and the tool calls, which is what the run drawer renders;
   * both were redacted by the repositories on write.
   */
  it('returns the run with its output and tool calls', async () => {
    const harness = createTestContainer({ now: NOW });
    const { runs } = await seedRuns(harness, 1);
    const run = runs[0]!;
    const workspace = await harness.doubles.repos.workspaces.create({
      kind: 'JOB',
      runnerKind: 'docker',
      image: 'agent-hangar/workspace:dev',
      repoUrl: 'https://github.com/acme/widgets',
      branch: 'main',
    });
    await harness.doubles.repos.toolCalls.start({
      workspaceId: workspace.id,
      jobRunId: run.id,
      callId: 'call-1',
      seq: 1,
      toolName: 'run_shell',
      args: { command: 'ls' },
    });
    await harness.doubles.repos.jobRuns.finish(run.id, {
      status: 'SUCCEEDED',
      usage: { inputTokens: 10, outputTokens: 5, stepCount: 2 },
      output: 'All issues triaged',
    });

    const response = await getRun(harness.container, readRequest(`/api/runs/${run.id}`), {
      id: run.id,
    });
    const detail = runDetail.parse(await response.json());
    expect(detail.run).toMatchObject({ id: run.id, status: 'SUCCEEDED' });
    expect(detail.output).toBe('All issues triaged');
    expect(detail.toolCalls.map((call) => call.callId)).toEqual(['call-1']);
  });

  /**
   * An unknown run is missing.
   */
  it('reports an unknown run as missing', async () => {
    const harness = createTestContainer({ now: NOW });
    const response = await getRun(harness.container, readRequest('/api/runs/nope'), { id: 'nope' });
    expect(response.status).toBe(404);
  });
});

describe('cancelRun', () => {
  /**
   * A delivery still waiting on the queue is removed and the run closed in one request; nothing is
   * published, because no worker holds the run. This is the case the whole route exists for: the
   * BullMQ job id of a manual run is the run id, so the id the browser was given addresses the
   * delivery as well as the row.
   */
  it('removes the queued delivery and closes the run', async () => {
    const harness = createTestContainer({ now: NOW });
    const runId = await seedManualRun(harness);

    const response = await cancelRun(harness.container, cancelRequest(runId), { id: runId });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await harness.doubles.repos.jobRuns.get(runId)).toMatchObject({ status: 'CANCELLED' });
    expect(harness.doubles.queues.scheduledJobs.jobs.has(runId)).toBe(false);
    expect(harness.doubles.redis.published).toEqual([]);
  });

  /**
   * A run the worker already picked up cannot be closed from here: the container and the exec
   * stream belong to the worker, so the request is published on the channel it subscribes to —
   * keyed by the run id, which is what the scheduled-job processor watches — and acknowledged
   * with `202`.
   */
  it('publishes a cancel command for a running run', async () => {
    const harness = createTestContainer({ now: NOW });
    const runId = await seedManualRun(harness);
    await harness.doubles.repos.jobRuns.setStatus(runId, 'RUNNING');

    const response = await cancelRun(harness.container, cancelRequest(runId), { id: runId });

    expect(response.status).toBe(202);
    expect(await harness.doubles.repos.jobRuns.get(runId)).toMatchObject({ status: 'RUNNING' });
    const [published] = harness.doubles.redis.published;
    expect(published?.channel).toBe(turnCommandChannel(runId));
    expect(turnCommand.parse(JSON.parse(published?.message ?? ''))).toEqual({ type: 'cancel' });
  });

  /**
   * A run a cron tick opened has no delivery under its id — the Job Scheduler enqueued the tick
   * before the row existed — so even while it reads `QUEUED` the only way to stop it is to ask the
   * worker that is already driving it.
   */
  it('publishes a cancel command for a queued run with no delivery of its own', async () => {
    const harness = createTestContainer({ now: NOW });
    const { runs } = await seedRuns(harness, 1);
    const runId = runs[0]!.id;

    const response = await cancelRun(harness.container, cancelRequest(runId), { id: runId });

    expect(response.status).toBe(202);
    expect(harness.doubles.redis.published).toHaveLength(1);
    expect(await harness.doubles.repos.jobRuns.get(runId)).toMatchObject({ status: 'QUEUED' });
  });

  /**
   * The race the two shapes exist for: the run still reads `QUEUED` but BullMQ has already handed
   * the delivery out, so removing it would be a lie. The command channel is used instead.
   */
  it('falls back to the command channel when the delivery is no longer removable', async () => {
    const harness = createTestContainer({ now: NOW });
    const runId = await seedManualRun(harness);
    harness.doubles.queues.scheduledJobs.jobs.get(runId)!.state = 'active';

    const response = await cancelRun(harness.container, cancelRequest(runId), { id: runId });

    expect(response.status).toBe(202);
    expect(harness.doubles.redis.published).toHaveLength(1);
    expect(await harness.doubles.repos.jobRuns.get(runId)).toMatchObject({ status: 'QUEUED' });
  });

  /**
   * A finished run has nothing to cancel, and saying so is more useful than a silent success the
   * UI would render as a pending cancel.
   */
  it('refuses to cancel a finished run', async () => {
    const harness = createTestContainer({ now: NOW });
    const runId = await seedManualRun(harness);
    await harness.doubles.repos.jobRuns.finish(runId, {
      status: 'SUCCEEDED',
      usage: { inputTokens: 0, outputTokens: 0, stepCount: 0 },
    });

    const response = await cancelRun(harness.container, cancelRequest(runId), { id: runId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'RUN_NOT_CANCELLABLE' } });
  });

  /**
   * The delivery is removed from Redis before the terminal status reaches Postgres, and the two
   * stores cannot commit together. The rule this protects is that a failure of the second write
   * does not strand the run: without the undo the delivery is gone while the row still says
   * `QUEUED`, so nothing would ever run it. The delivery goes back under the same id and payload.
   */
  it('puts the queued delivery back when the cancelled status cannot be written', async () => {
    const harness = createTestContainer({ now: NOW });
    const runId = await seedManualRun(harness);
    vi.spyOn(harness.doubles.repos.jobRuns, 'finish').mockRejectedValue(
      new Error('database unreachable'),
    );

    const response = await cancelRun(harness.container, cancelRequest(runId), { id: runId });

    expect(response.status).toBe(500);
    expect(harness.doubles.queues.scheduledJobs.jobs.has(runId)).toBe(true);
    expect(await harness.doubles.repos.jobRuns.get(runId)).toMatchObject({ status: 'QUEUED' });
    expect(harness.doubles.redis.published).toEqual([]);
  });

  /**
   * Both the status write and the undo failing is the one case compensation cannot repair: the
   * request still fails with the error that explains it rather than with the undo's, and the log
   * line naming the run is the only record that a queued run has no delivery behind it.
   */
  it('reports a cancel it could not undo', async () => {
    const harness = createTestContainer({ now: NOW });
    const runId = await seedManualRun(harness);
    vi.spyOn(harness.doubles.repos.jobRuns, 'finish').mockRejectedValue(
      new Error('database unreachable'),
    );
    harness.doubles.queues.scheduledJobs.addFailure = new Error('redis unreachable');

    const response = await cancelRun(harness.container, cancelRequest(runId), { id: runId });

    expect(response.status).toBe(500);
    expect(harness.doubles.queues.scheduledJobs.jobs.has(runId)).toBe(false);
    expect(harness.doubles.logOutput()).toContain('could not undo a partial run cancel');
  });

  /**
   * An unknown run is a missing resource — including a `Turn.id`, which belongs to another table
   * and is looked up in none of this route's.
   */
  it('reports an unknown run as missing', async () => {
    const { container } = createTestContainer({ now: NOW });
    const response = await cancelRun(container, cancelRequest('nope'), { id: 'nope' });
    expect(response.status).toBe(404);
  });

  /**
   * Cancel is a state-changing route, so it carries the same origin guard as the rest: a foreign
   * page must not be able to stop the user's work.
   */
  it('rejects a cross-origin cancel', async () => {
    const harness = createTestContainer({ now: NOW });
    const runId = await seedManualRun(harness);
    const request = foreignRequest(`/api/runs/${runId}/cancel`, 'POST', {});

    const response = await cancelRun(harness.container, request, { id: runId });

    expect(response.status).toBe(403);
    expect(await harness.doubles.repos.jobRuns.get(runId)).toMatchObject({ status: 'QUEUED' });
  });
});
