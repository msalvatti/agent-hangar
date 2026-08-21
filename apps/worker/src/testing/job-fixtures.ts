/**
 * Fixtures shared by the scheduled-job processor's test files.
 *
 * Layer: test double.
 *
 * The run lifecycle and the rules about which run a delivery is entitled to drive are tested in
 * separate files, against the same job, the same delivery shape and the same scripted runtime. A
 * second copy of "an enabled job that prints the date" would be a second place for the two halves
 * to drift apart.
 */
import type {
  AgentEvent,
  RunScheduledJobPayload,
  ScheduledJob,
  WorkspaceHandle,
} from '@agent-hangar/core';

import { createRunScheduledJobProcessor } from '../processors/run-scheduled-job.js';
import type { ProcessorJob } from '../processors/types.js';

import type { TestContainer } from './test-container.js';

/** Schedule of the fixture job: every five minutes, which no test waits for. */
export const JOB_CRON = '*/5 * * * *';

/** Repository the scheduled-run fixtures work against. */
const FIXTURE_JOB_REPO_URL = 'https://github.com/octocat/Hello-World.git';

/**
 * The events a successful run produces, in the order the runtime writes them.
 *
 * @returns A fresh array, so a test may edit its copy.
 */
export function happyJobScript(): AgentEvent[] {
  return [
    { type: 'turn.started', turnId: 'ignored', at: '2026-01-01T00:00:00.000Z' },
    { type: 'step.started', step: 1 },
    {
      type: 'tool.call',
      callId: 'call-1',
      name: 'run_shell',
      args: { command: 'date' },
      seq: 1,
    },
    { type: 'tool.output.delta', callId: 'call-1', stream: 'stdout', text: 'Sun 1 Feb 2026' },
    {
      type: 'tool.result',
      callId: 'call-1',
      exitCode: 0,
      bytes: 29,
      durationMs: 8,
      status: 'SUCCEEDED',
    },
    {
      type: 'turn.completed',
      usage: { inputTokens: 5, outputTokens: 7 },
      steps: 1,
      finalMessage: 'I printed the current date.',
    },
  ];
}

/**
 * Seeds a scheduled job.
 *
 * @param container - The test container.
 * @param overrides - Whether the job is enabled, and the schedule to give it.
 * @returns The job.
 */
export async function seedJob(
  container: TestContainer,
  overrides: { enabled?: boolean; cron?: string } = {},
): Promise<ScheduledJob> {
  return container.repos.scheduledJobs.create({
    name: 'print the date',
    cron: overrides.cron ?? JOB_CRON,
    timezone: 'UTC',
    prompt: 'print date',
    repoUrl: FIXTURE_JOB_REPO_URL,
    branch: 'master',
    enabled: overrides.enabled ?? true,
  });
}

/**
 * Builds the structural part of a BullMQ delivery of `run-scheduled-job`.
 *
 * @param jobId - The job the delivery belongs to.
 * @param trigger - What produced it.
 * @param extra - The tick's timestamp, the manual run it names, and how many times BullMQ
 *   recovered it from the stalled set.
 * @returns The delivery.
 */
export function jobDelivery(
  jobId: string,
  trigger: RunScheduledJobPayload['trigger'] = 'SCHEDULE',
  extra: { timestamp?: number; runId?: string; stalledCounter?: number } = {},
): ProcessorJob<RunScheduledJobPayload> {
  return {
    id: 'delivery-1',
    name: 'run-scheduled-job',
    data: { jobId, trigger, ...(extra.runId === undefined ? {} : { runId: extra.runId }) },
    ...(extra.stalledCounter === undefined ? {} : { stalledCounter: extra.stalledCounter }),
    ...(extra.timestamp === undefined ? {} : { timestamp: extra.timestamp }),
  };
}

/**
 * Runs the scheduled-job processor over a delivery.
 *
 * @param container - The test container, which satisfies `ProcessorDeps`.
 * @param delivery - The delivery to process.
 */
export async function runScheduledJobOn(
  container: TestContainer,
  delivery: ProcessorJob<RunScheduledJobPayload>,
): Promise<void> {
  await createRunScheduledJobProcessor(container)(delivery);
}

/**
 * Every workspace handle the runner was asked to destroy.
 *
 * @param container - The test container.
 * @returns The handles, in call order.
 */
export function destroyedHandles(container: TestContainer): WorkspaceHandle[] {
  return container.runner.calls
    .filter((call) => call.method === 'destroy')
    .map((call) => call.args[0] as WorkspaceHandle);
}
