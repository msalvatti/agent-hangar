/** @vitest-environment node */
/**
 * Unit tests for the run history and run detail routes.
 *
 * Layer: unit.
 * Goal: the history is bounded and newest-first, the detail carries the output and the tool calls,
 * and an unknown job or run is reported as missing rather than as an empty list.
 * Mocks: the `bullmq` module.
 */
import { listRunsResponse, runDetail } from '@agent-hangar/core';
import type { JobRun } from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import { createTestContainer } from '../testing/test-container';
import type { TestContainer } from '../testing/test-container';

import { getRun, listRuns, RUNS_PAGE_SIZE } from './runs';

vi.mock('bullmq', () => import('../testing/fake-queue'));

/** Instant every container in this file starts from. */
const NOW = new Date('2026-08-19T10:00:00.000Z');

/**
 * Builds a read request.
 *
 * @param path - Path below the API root.
 * @returns The request.
 */
function read(path: string): Request {
  return new Request(`http://127.0.0.1:3000${path}`);
}

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
  const job = await harness.doubles.repos.scheduledJobs.create({
    name: 'Nightly triage',
    cron: '0 3 * * *',
    timezone: 'Europe/Lisbon',
    prompt: 'Triage new issues',
    repoUrl: 'https://github.com/acme/widgets',
    branch: 'main',
    enabled: true,
  });
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

describe('listRuns', () => {
  /**
   * The history is newest first, because the table's first row is the run the user just started.
   */
  it('lists the runs of a job, newest first', async () => {
    const harness = createTestContainer({ now: NOW });
    const { jobId, runs } = await seedRuns(harness, 3);
    const response = await listRuns(harness.container, read(`/api/jobs/${jobId}/runs`), {
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
    const response = await listRuns(harness.container, read(`/api/jobs/${jobId}/runs`), {
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
    const response = await listRuns(harness.container, read('/api/jobs/nope/runs'), { id: 'nope' });
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

    const response = await getRun(harness.container, read(`/api/runs/${run.id}`), { id: run.id });
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
    const response = await getRun(harness.container, read('/api/runs/nope'), { id: 'nope' });
    expect(response.status).toBe(404);
  });
});
