/**
 * Unit tests for the `run-scheduled-job` processor.
 *
 * Layer: unit.
 * Goal: the two guarantees of spec 04 (c) — one fresh workspace per run, always destroyed in a
 * `finally`, and a tick that overlaps the previous run recorded rather than queued — plus the
 * request the runtime receives, every failure path, and the run times the tick leaves behind.
 * Mocks: `createTestContainer` plus runner subclasses for failures the fake cannot produce.
 */
import {
  DEFAULT_JOB_TURN_LIMITS,
  nextRunAt,
  OVERLAP_SKIP_REASON,
  turnRequestSchema,
} from '@agent-hangar/core';
import type {
  AgentEvent,
  ExecEvent,
  ExecSpec,
  RunScheduledJobPayload,
  ScheduledJob,
  WorkspaceHandle,
  WorkspaceSpec,
} from '@agent-hangar/core';
import {
  assertNoCanary,
  FakeClock,
  FakeWorkspaceRunner,
  GITHUB_CANARY,
  OPENAI_CANARY,
} from '@agent-hangar/core/testing';
import type { ExecScript, FakeWorkspaceRunnerOptions } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  createTestContainer,
  FakeSecretsService,
  scriptedRuntime,
  stdinOf,
} from '../testing/index.js';
import type { TestContainer } from '../testing/index.js';

import { createRunScheduledJobProcessor } from './run-scheduled-job.js';
import type { ProcessorJob } from './types.js';

const REPO_URL = 'https://github.com/octocat/Hello-World.git';
const CRON = '*/5 * * * *';

/** A runner that has no workspace image. */
class UncreatableRunner extends FakeWorkspaceRunner {
  constructor(
    private readonly failure: unknown,
    options: FakeWorkspaceRunnerOptions = {},
  ) {
    super(options);
  }

  override async create(): Promise<WorkspaceHandle> {
    await Promise.resolve();
    throw this.failure;
  }
}

/** A runner whose exec cannot be started at all. */
class UnreachableRunner extends FakeWorkspaceRunner {
  constructor(
    private readonly failure: unknown,
    options: FakeWorkspaceRunnerOptions = {},
  ) {
    super(options);
  }

  override async *exec(): AsyncIterable<ExecEvent> {
    await Promise.resolve();
    throw this.failure;
  }
}

/** The events a successful run produces. */
function happyScript(): AgentEvent[] {
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

/** How a test wants its container wired. */
interface SetupOptions {
  script?: ExecScript;
  secrets?: FakeSecretsService;
  runner?: (options: FakeWorkspaceRunnerOptions) => FakeWorkspaceRunner;
}

/** Builds a test container whose runner already carries the script the test needs. */
function setup(options: SetupOptions = {}): TestContainer {
  const clock = new FakeClock();
  const runnerOptions: FakeWorkspaceRunnerOptions = {
    clock,
    scripts: options.script === undefined ? [] : [options.script],
  };
  const runner = (options.runner ?? ((opts) => new FakeWorkspaceRunner(opts)))(runnerOptions);
  return createTestContainer({
    clock,
    runner,
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
  });
}

/** Seeds an enabled scheduled job. */
async function seedJob(
  container: TestContainer,
  overrides: { enabled?: boolean; cron?: string } = {},
): Promise<ScheduledJob> {
  return container.repos.scheduledJobs.create({
    name: 'print the date',
    cron: overrides.cron ?? CRON,
    timezone: 'UTC',
    prompt: 'print date',
    repoUrl: REPO_URL,
    branch: 'master',
    enabled: overrides.enabled ?? true,
  });
}

/** Builds the structural part of a BullMQ delivery. */
function delivery(
  jobId: string,
  trigger: RunScheduledJobPayload['trigger'] = 'SCHEDULE',
  timestamp?: number,
): ProcessorJob<RunScheduledJobPayload> {
  return {
    id: 'delivery-1',
    name: 'run-scheduled-job',
    data: { jobId, trigger },
    attemptsMade: 0,
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

/** Runs the processor over a delivery. */
async function run(
  container: TestContainer,
  job: ProcessorJob<RunScheduledJobPayload>,
): Promise<void> {
  await createRunScheduledJobProcessor(container)(job);
}

/** The turn request the runtime was handed. */
async function requestSentTo(container: TestContainer): Promise<unknown> {
  const call = container.runner.calls.findLast((entry) => entry.method === 'exec');
  return turnRequestSchema.parse(JSON.parse(await stdinOf(call?.args[1] as ExecSpec)));
}

describe('createRunScheduledJobProcessor', () => {
  /**
   * The whole flow: a fresh `JOB` workspace labelled with the run, a request carrying only the
   * job's prompt, the run's own tool log, the final answer as the run's output, and the container
   * destroyed before the processor returns.
   */
  it('runs a tick in a fresh workspace and destroys it', async () => {
    const container = setup({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    const spec = container.runner.calls.find((call) => call.method === 'create')
      ?.args[0] as WorkspaceSpec;
    expect(spec.kind).toBe('JOB');
    expect(spec.labels).toMatchObject({ 'ah.kind': 'JOB', 'ah.instance': 'w2b-unit' });
    expect(spec.labels['ah.chat']).toBeUndefined();

    const request = (await requestSentTo(container)) as {
      items: { content?: string }[];
      limits: unknown;
      prepare: { clone: boolean };
      repo: { workBranch: string; baseBranch: string };
    };
    expect(request.items).toEqual([{ role: 'user', content: 'print date' }]);
    expect(request.limits).toEqual(DEFAULT_JOB_TURN_LIMITS);
    expect(request.prepare.clone).toBe(true);
    expect(request.repo.baseBranch).toBe('master');

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'SUCCEEDED',
      output: 'I printed the current date.',
      inputTokens: 5,
      outputTokens: 7,
      stepCount: 1,
      trigger: 'SCHEDULE',
    });
    expect(request.repo.workBranch).toBe(`agent/job-${runs[0]?.id.slice(0, 8) ?? ''}`);

    const logs = await container.repos.jobRuns
      .get(runs[0]?.id ?? '')
      .then(async () => container.repos.toolCalls.listByJobRun(runs[0]?.id ?? ''));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      jobRunId: runs[0]?.id,
      turnId: null,
      resultHead: 'Sun 1 Feb 2026',
    });

    expect(container.runner.calls.filter((call) => call.method === 'destroy')).toHaveLength(1);
    const workspaces = [...container.repos.store.workspaces.values()];
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.status).toBe('DESTROYED');
  });

  /**
   * The tick moves the job's clock forward: `lastRunAt` is now and `nextRunAt` is the cron's next
   * occurrence, computed by the same function the API uses.
   */
  it('records the run times of the tick', async () => {
    const container = setup({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    const updated = await container.repos.scheduledJobs.get(job.id);
    expect(updated?.lastRunAt).toEqual(container.clock.now());
    expect(updated?.nextRunAt).toEqual(
      nextRunAt({ cron: CRON, timezone: 'UTC' }, container.clock.now()),
    );
  });

  /**
   * A manual run is recorded as such, and the tick it belongs to is the delivery's own timestamp
   * when BullMQ supplied one.
   */
  it('records a manual run against the delivery timestamp', async () => {
    const container = setup({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const tick = Date.parse('2026-02-01T09:00:00.000Z');

    await run(container, delivery(job.id, 'MANUAL', tick));

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs[0]).toMatchObject({ trigger: 'MANUAL', scheduledFor: new Date(tick) });
  });

  /**
   * A tick that fires while the previous run is still executing is recorded as a failure and does
   * nothing else: no container, and no change to the run times the executing run owns.
   */
  it('records an overlapping tick without starting a container', async () => {
    const container = setup({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const running = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'test-model',
      scheduledFor: container.clock.now(),
    });
    await container.repos.jobRuns.setStatus(running.id, 'RUNNING');

    await run(container, delivery(job.id));

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs).toHaveLength(2);
    expect(runs.find((entry) => entry.id !== running.id)).toMatchObject({
      status: 'FAILED',
      error: OVERLAP_SKIP_REASON,
    });
    expect(container.runner.calls).toHaveLength(0);
    expect((await container.repos.scheduledJobs.get(job.id))?.lastRunAt).toBeNull();
  });

  /**
   * A job that was deleted, or disabled since the scheduler was registered, is acknowledged and
   * nothing is recorded: a disabled job that still ran would be a surprise the UI cannot explain.
   */
  it('skips a job that is gone or disabled', async () => {
    const container = setup();
    const disabled = await seedJob(container, { enabled: false });

    await run(container, delivery('no-such-job'));
    await run(container, delivery(disabled.id));

    expect(await container.repos.jobRuns.listByJob(disabled.id)).toHaveLength(0);
    expect(container.runner.calls).toHaveLength(0);
    expect(container.logs.join('')).toContain('scheduled job is disabled');
  });

  /**
   * A failure the runtime reported is recorded on the run, and the container is destroyed anyway.
   */
  it('records a reported failure and still destroys the workspace', async () => {
    const container = setup({
      script: scriptedRuntime([
        { type: 'turn.started', turnId: 'x', at: '2026-01-01T00:00:00.000Z' },
        { type: 'turn.failed', error: { code: 'auth', message: 'the key was rejected' } },
      ]),
    });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs[0]).toMatchObject({ status: 'FAILED', error: 'auth: the key was rejected' });
    expect([...container.repos.store.workspaces.values()][0]?.status).toBe('DESTROYED');
  });

  /**
   * Cancelling a run records it as cancelled and still tears the container down.
   */
  it('records a cancellation and destroys the workspace', async () => {
    const container = setup({
      script: scriptedRuntime([
        { type: 'turn.started', turnId: 'x', at: '2026-01-01T00:00:00.000Z' },
        { type: 'turn.cancelled' },
      ]),
    });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    expect((await container.repos.jobRuns.listByJob(job.id))[0]?.status).toBe('CANCELLED');
    expect([...container.repos.store.workspaces.values()][0]?.status).toBe('DESTROYED');
  });

  /**
   * A run cancelled while the runtime ignores the signal is still recorded as cancelled, and its
   * container is still destroyed.
   */
  it('closes out a cancellation the runtime never acknowledged', async () => {
    const container = setup({
      script: scriptedRuntime(
        [
          { type: 'turn.started', turnId: 'x', at: '2026-01-01T00:00:00.000Z' },
          { type: 'prepare.progress', message: 'Cloning…' },
        ],
        { holdUntilSignal: { afterEvent: 2 } },
      ),
    });
    const job = await seedJob(container);
    const publish = container.publisher.publish.bind(container.publisher);
    vi.spyOn(container.publisher, 'publish').mockImplementation(async (runId, event) => {
      const id = await publish(runId, event);
      if (event.type === 'prepare.progress') {
        container.commands.emitCancel(runId);
      }
      return id;
    });

    await run(container, delivery(job.id));

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs[0]?.status).toBe('CANCELLED');
    expect(container.publisher.eventsFor(runs[0]?.id ?? '').at(-1)).toEqual({
      type: 'turn.cancelled',
    });
    expect([...container.repos.store.workspaces.values()][0]?.status).toBe('DESTROYED');
    vi.restoreAllMocks();
  });

  /**
   * A failure that is not the schedule's fault must not be swallowed by the run-times update: a
   * database that is down has to surface, not be logged as a cron problem.
   */
  it('propagates a failure that is not an invalid schedule', async () => {
    const container = setup({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    vi.spyOn(container.repos.scheduledJobs, 'setRunTimes').mockRejectedValue(
      new Error('database is down'),
    );

    await expect(run(container, delivery(job.id))).rejects.toThrow(/database is down/);
    vi.restoreAllMocks();
  });

  /**
   * A runtime that exits without saying anything is a failed run, and the UI's stream still ends.
   */
  it('fails a run whose runtime said nothing', async () => {
    const container = setup({ script: scriptedRuntime([], { exitCode: 3 }) });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs[0]?.error).toContain('runtime exited with code 3');
    expect(container.publisher.eventsFor(runs[0]?.id ?? '').at(-1)).toMatchObject({
      type: 'turn.failed',
    });
  });

  /**
   * Without a credential there is nothing to inject, so the run fails before a container exists —
   * and the run times still move, because this tick did happen.
   */
  it('fails the run when a credential is missing', async () => {
    const container = setup({ secrets: new FakeSecretsService({ GITHUB_PAT: GITHUB_CANARY }) });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    expect((await container.repos.jobRuns.listByJob(job.id))[0]?.error).toContain(
      'secrets_missing',
    );
    expect(container.runner.calls).toHaveLength(0);
    expect((await container.repos.scheduledJobs.get(job.id))?.lastRunAt).not.toBeNull();
  });

  /**
   * A missing image fails the run without an exec, and the run times still move.
   */
  it('fails the run when the workspace image is missing', async () => {
    const container = setup({
      runner: (options) =>
        new UncreatableRunner(
          Object.assign(new Error('No such image'), { code: 'IMAGE' }),
          options,
        ),
    });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    expect((await container.repos.jobRuns.listByJob(job.id))[0]?.error).toContain(
      'workspace_create_failed',
    );
    expect((await container.repos.scheduledJobs.get(job.id))?.nextRunAt).not.toBeNull();
  });

  /**
   * An unreachable daemon rejects the job so BullMQ retries it, and the teardown still runs.
   */
  it('rejects when the daemon is unreachable', async () => {
    const container = setup({
      runner: (options) =>
        new UnreachableRunner(
          Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
          options,
        ),
    });
    const job = await seedJob(container);

    await expect(run(container, delivery(job.id))).rejects.toThrow(/unreachable/);

    expect((await container.repos.jobRuns.listByJob(job.id))[0]?.status).toBe('FAILED');
    expect([...container.repos.store.workspaces.values()][0]?.status).toBe('DESTROYED');
  });

  /**
   * A destroy the runner refuses is logged, not thrown: the run is already recorded and the
   * collector will reap the container by its label on the next tick.
   */
  it('logs a destroy the runner refused', async () => {
    const container = setup({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    vi.spyOn(container.runner, 'destroy').mockRejectedValueOnce(new Error('daemon busy'));

    await run(container, delivery(job.id));

    expect(container.logs.join('')).toContain('destroying a run workspace failed');
    expect((await container.repos.jobRuns.listByJob(job.id))[0]?.status).toBe('SUCCEEDED');
    expect([...container.repos.store.workspaces.values()][0]?.status).toBe('DESTROYED');
    vi.restoreAllMocks();
  });

  /**
   * A schedule the parser rejects cannot come from the API, but it must not stop the worker: the
   * tick is still recorded and only the next occurrence is left unknown.
   */
  it('records the tick even when the schedule cannot be parsed', async () => {
    const container = setup({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const stored = container.repos.store.scheduledJobs.get(job.id);
    if (stored !== undefined) {
      stored.cron = 'not a cron';
    }

    await run(container, delivery(job.id));

    const updated = await container.repos.scheduledJobs.get(job.id);
    expect(updated?.lastRunAt).not.toBeNull();
    expect(updated?.nextRunAt).toBeNull();
    expect(container.logs.join('')).toContain('invalid schedule');
  });

  /**
   * A run that ends before the executor could record an outcome is still closed out, so a job's
   * history never shows a run stuck in `RUNNING`.
   */
  it('closes out a run the processor could not finish', async () => {
    const container = setup({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    vi.spyOn(container.repos.workspaces, 'setStatus').mockRejectedValueOnce(
      new Error('database is down'),
    );

    await expect(run(container, delivery(job.id))).rejects.toThrow(/database/);

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs[0]?.status).toBe('FAILED');
    expect(runs[0]?.error).toContain('worker error');
    vi.restoreAllMocks();
  });

  /**
   * The credentials the container runs with must reach neither the run's rows nor its stream.
   */
  it('lets no credential reach the run record or its stream', async () => {
    const container = setup({
      script: scriptedRuntime([
        {
          type: 'turn.completed',
          usage: { inputTokens: 1, outputTokens: 1 },
          steps: 1,
          finalMessage: `key is ${OPENAI_CANARY}`,
        },
      ]),
    });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(() => {
      assertNoCanary(JSON.stringify(runs));
    }).not.toThrow();
    expect(runs[0]?.output).toContain('[REDACTED]');
    expect(() => {
      assertNoCanary(JSON.stringify(container.publisher.records));
    }).not.toThrow();
  });
});
