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

import type { ServerContainer } from '../container';
import { foreignRequest, readRequest, writeRequest } from '../testing/requests';
import { createTestContainer } from '../testing/test-container';
import type { TestContainer } from '../testing/test-container';

import { NO_USAGE } from './guards';
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
    expect(await response.json()).toMatchObject({ error: { message: 'Scheduled job not found' } });
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
   * The branch a scheduled run pushed to is the one fact it produces that outlives its container,
   * so the detail route is where the drawer reads it back — long after the container and the event
   * stream that reported it are both gone.
   */
  it('returns where the run pushed', async () => {
    const harness = createTestContainer({ now: NOW });
    const { runs } = await seedRuns(harness, 1);
    const run = runs[0]!;
    await harness.doubles.repos.jobRuns.recordPush(run.id, {
      workBranch: 'agent/job-2f7c11a0',
      lastPushedSha: 'c0ffee1234567890',
    });

    const response = await getRun(harness.container, readRequest(`/api/runs/${run.id}`), {
      id: run.id,
    });

    expect(runDetail.parse(await response.json()).push).toEqual({
      branch: 'agent/job-2f7c11a0',
      sha: 'c0ffee1234567890',
    });
  });

  /** A run that pushed nothing reports no push rather than a half-built one. */
  it('reports no push for a run that pushed nothing', async () => {
    const harness = createTestContainer({ now: NOW });
    const { runs } = await seedRuns(harness, 1);

    const response = await getRun(harness.container, readRequest(`/api/runs/${runs[0]!.id}`), {
      id: runs[0]!.id,
    });

    expect(runDetail.parse(await response.json()).push).toBeNull();
  });

  /**
   * The two columns are written by one statement, so only something outside the application can
   * leave one of them set. The route answers that the same way it answers a run that never pushed,
   * rather than rendering a branch at an empty revision.
   */
  it('reports no push for a row carrying only half of one', async () => {
    const harness = createTestContainer({ now: NOW });
    const { runs } = await seedRuns(harness, 1);
    const run = runs[0]!;
    await harness.doubles.repos.jobRuns.recordPush(run.id, {
      workBranch: 'agent/job-2f7c11a0',
      lastPushedSha: 'c0ffee1234567890',
    });
    const pushed = await harness.doubles.repos.jobRuns.get(run.id);
    vi.spyOn(harness.doubles.repos.jobRuns, 'get').mockResolvedValue({
      ...pushed!,
      lastPushedSha: null,
    });

    const response = await getRun(harness.container, readRequest(`/api/runs/${run.id}`), {
      id: run.id,
    });

    expect(runDetail.parse(await response.json()).push).toBeNull();
  });

  /**
   * The other half of the same pair: a branch recorded with no commit is as unusable as a commit
   * with no branch. Both columns are written by one statement, so either alone is a row nothing
   * produces — and rendered, it would show a branch at commit `undefined`.
   */
  it('reports no push for a row carrying only the branch', async () => {
    const harness = createTestContainer({ now: NOW });
    const { runs } = await seedRuns(harness, 1);
    const run = runs[0]!;
    await harness.doubles.repos.jobRuns.recordPush(run.id, {
      workBranch: 'agent/job-2f7c11a0',
      lastPushedSha: 'c0ffee1234567890',
    });
    const pushed = await harness.doubles.repos.jobRuns.get(run.id);
    vi.spyOn(harness.doubles.repos.jobRuns, 'get').mockResolvedValue({
      ...pushed!,
      workBranch: null,
    });

    const response = await getRun(harness.container, readRequest(`/api/runs/${run.id}`), {
      id: run.id,
    });

    expect(runDetail.parse(await response.json()).push).toBeNull();
  });

  /**
   * An unknown run is missing.
   */
  it('reports an unknown run as missing', async () => {
    const harness = createTestContainer({ now: NOW });
    const response = await getRun(harness.container, readRequest('/api/runs/nope'), { id: 'nope' });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { message: 'Run not found' } });
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
   * A run the worker already picked up keeps its container and its exec stream there, so the
   * request is published on the channel the scheduled-job processor subscribes to — keyed by the
   * run id — and acknowledged with `202`. The outcome, though, is recorded here: `202` says the
   * run is being stopped, and leaving the record to the worker is what let a run the API had
   * already accepted a cancellation for come back as `FAILED`.
   */
  it('publishes a cancel command for a running run and records the cancellation', async () => {
    const harness = createTestContainer({ now: NOW });
    const runId = await seedManualRun(harness);
    await harness.doubles.repos.jobRuns.setStatus(runId, 'RUNNING');

    const response = await cancelRun(harness.container, cancelRequest(runId), { id: runId });

    expect(response.status).toBe(202);
    expect(await harness.doubles.repos.jobRuns.get(runId)).toMatchObject({ status: 'CANCELLED' });
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
    expect(await harness.doubles.repos.jobRuns.get(runId)).toMatchObject({ status: 'CANCELLED' });
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
    expect(await harness.doubles.repos.jobRuns.get(runId)).toMatchObject({ status: 'CANCELLED' });
  });

  /**
   * The window this route's write exists to close, driven at the seam where it is real: the worker
   * had already decided the run could not proceed and records `FAILED` while this request is
   * between its publish and its own write. Before, the request answered `202` — telling the browser
   * the run was being stopped — and the row then read `FAILED`, contradicting it. Now the write is
   * refused, the answer is `409`, and what the user is told matches what is stored.
   */
  it('refuses rather than promising a cancel the worker has already outrun', async () => {
    const harness = createTestContainer({ now: NOW });
    const runId = await seedManualRun(harness);
    await harness.doubles.repos.jobRuns.setStatus(runId, 'RUNNING');
    const publish = harness.doubles.redis.publish.bind(harness.doubles.redis);
    vi.spyOn(harness.doubles.redis, 'publish').mockImplementation(async (channel, message) => {
      const delivered = await publish(channel, message);
      await harness.doubles.repos.jobRuns.finish(runId, {
        status: 'FAILED',
        usage: NO_USAGE,
        error: 'the worker got there first',
      });
      return delivered;
    });

    const response = await cancelRun(harness.container, cancelRequest(runId), { id: runId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'RUN_NOT_CANCELLABLE' } });
    expect(await harness.doubles.repos.jobRuns.get(runId)).toMatchObject({
      status: 'FAILED',
      error: 'the worker got there first',
    });
  });

  /**
   * The same window on the queued path. The delivery was taken off the queue, so nothing is left
   * to run — putting it back would be the wrong repair — and the run already carries the outcome
   * the worker wrote, so the request reports that rather than claiming a cancellation.
   */
  it('refuses without re-enqueueing when the run finished after its delivery was removed', async () => {
    const harness = createTestContainer({ now: NOW });
    const runId = await seedManualRun(harness);
    const delivery = harness.doubles.queues.scheduledJobs.jobs.get(runId);
    const remove = delivery?.remove.bind(delivery);
    vi.spyOn(delivery!, 'remove').mockImplementation(async () => {
      await remove?.();
      await harness.doubles.repos.jobRuns.finish(runId, {
        status: 'FAILED',
        usage: NO_USAGE,
        error: 'the worker got there first',
      });
    });

    const response = await cancelRun(harness.container, cancelRequest(runId), { id: runId });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'RUN_NOT_CANCELLABLE', message: 'This run has already finished' },
    });
    expect(await harness.doubles.repos.jobRuns.get(runId)).toMatchObject({ status: 'FAILED' });
    expect(harness.doubles.queues.scheduledJobs.added).toHaveLength(1);
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
    // The code the page branches on and the sentence it shows: a Stop pressed on a run that has
    // already finished is not an error the user made, and the wording is what says so.
    expect(await response.json()).toMatchObject({
      error: { code: 'RUN_NOT_CANCELLABLE', message: 'This run has already finished' },
    });
    // And the worker is not told to stop something that has already stopped: the command channel
    // is shared with a live run of the same id, and a cancel published for a finished one is a
    // message a listener may still be there to act on.
    expect(harness.doubles.redis.published).toEqual([]);
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
    // The run is named on the line, and what failed is classified rather than quoted: this row is
    // now `QUEUED` with no delivery behind it, and its id is all anyone has to find it by.
    expect(
      harness.doubles
        .logOutput()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    ).toContainEqual(
      expect.objectContaining({ msg: 'could not undo a partial run cancel', runId }),
    );
  });

  /**
   * An unknown run is a missing resource — including a `Turn.id`, which belongs to another table
   * and is looked up in none of this route's.
   */
  it('reports an unknown run as missing', async () => {
    const { container } = createTestContainer({ now: NOW });
    const response = await cancelRun(container, cancelRequest('nope'), { id: 'nope' });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { message: 'Run not found' } });
  });

  /**
   * Every read of this file is refused when the request is addressed to a host this instance does
   * not answer for. A run's transcript and a job's history are the pages an attacking page would
   * read through a rebound name.
   */
  it.each([
    [
      'GET /api/jobs/:id/runs',
      (container: ServerContainer, request: Request) =>
        listRuns(container, request, { id: 'nope' }),
    ],
    [
      'GET /api/runs/:id',
      (container: ServerContainer, request: Request) => getRun(container, request, { id: 'nope' }),
    ],
    [
      'POST /api/runs/:id/cancel',
      (container: ServerContainer, request: Request) =>
        cancelRun(container, request, { id: 'nope' }),
    ],
  ])('refuses %s addressed to a rebound host', async (_route, invoke) => {
    const harness = createTestContainer({ now: NOW });

    const response = await invoke(
      harness.container,
      new Request('http://attacker.test/api', { headers: { host: 'attacker.test' } }),
    );

    expect(response.status).toBe(403);
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
