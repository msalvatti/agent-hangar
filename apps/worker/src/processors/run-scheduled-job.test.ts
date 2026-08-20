/**
 * Unit tests for the run lifecycle of the `run-scheduled-job` processor.
 *
 * Layer: unit.
 * Goal: the first guarantee of spec 04 (c) — every run gets its own container and that container
 * is destroyed in a `finally`, whatever happened — plus the request the runtime receives, every
 * failure path, cancellation, and the run times a tick leaves behind. Which run a delivery is
 * entitled to drive is the subject of `run-scheduled-job-deliveries.test.ts`.
 * Mocks: the shared processor fixtures over in-memory repositories and the fake runner.
 */
import { DEFAULT_JOB_TURN_LIMITS, JOB_NAMES, nextRunAt } from '@agent-hangar/core';
import type { WorkspaceSpec } from '@agent-hangar/core';
import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  FakeSecretsService,
  happyJobScript as happyScript,
  ImagelessRunner,
  JOB_CRON as CRON,
  jobDelivery as delivery,
  requestSentTo,
  runScheduledJobOn as run,
  scriptedRuntime,
  seedJob,
  setupProcessorContainer,
  UncreatableRunner,
  UnreachableRunner,
} from '../testing/index.js';

import { WORKSPACE_RECLAIMED_CODE } from './constants.js';
import { createGcProcessor } from './gc.js';

describe('createRunScheduledJobProcessor', () => {
  /**
   * A job workspace's idle clock is stamped when its row is inserted and never bumped — only a
   * chat turn calls `markActive` — so provisioning that outlives the TTL leaves the row eligible
   * the instant it turns `READY`, which is the gap this test puts the collector into. Ageing the
   * row is how that precondition is expressed without waiting out the TTL; the collector runs on
   * its own queue, so this is a race inside one process rather than one that needs two workers.
   *
   * What is asserted is the outcome: nothing is executed in a container somebody else is removing,
   * and the run says which of the two things happened rather than becoming a generic failure.
   */
  it('ends the run rather than executing in a workspace the collector reclaimed', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const setStatus = container.repos.workspaces.setStatus.bind(container.repos.workspaces);
    vi.spyOn(container.repos.workspaces, 'setStatus').mockImplementation(
      async (id, status, update) => {
        const row = await setStatus(id, status, update);
        if (status === 'READY') {
          const stored = container.repos.store.workspaces.get(id);
          if (stored !== undefined) {
            stored.lastActiveAt = new Date(container.clock.now().getTime() - 60 * 60_000);
          }
          await createGcProcessor(container)({
            id: 'gc-1',
            name: JOB_NAMES.reapIdle,
            data: {},
            attemptsMade: 0,
          });
        }
        return row;
      },
    );

    await run(container, delivery(job.id));
    vi.restoreAllMocks();

    expect(container.runner.calls.some((call) => call.method === 'exec')).toBe(false);
    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs[0]?.status).toBe('FAILED');
    expect(runs[0]?.error).toContain(WORKSPACE_RECLAIMED_CODE);
    // The run names the workspace it provisioned, which is what lets a later recovery find the row
    // if this process dies; what losing means is that it never took it, and the collector's
    // teardown — not this run — owns the container from here.
    expect(runs[0]?.workspaceId).not.toBeNull();
    expect(container.logs.join('')).toContain('was reclaimed before it could be used');
  });

  /**
   * The other half: the conditional write must not change an ordinary tick. Nothing takes the
   * workspace, so the run takes it, executes, and records the workspace it used.
   */
  it('takes its own workspace and records it when nothing else wants it', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs[0]?.status).toBe('SUCCEEDED');
    expect(runs[0]?.workspaceId).not.toBeNull();
    expect(container.runner.calls.some((call) => call.method === 'exec')).toBe(true);
  });

  /**
   * The whole flow: a fresh `JOB` workspace labelled with the run, a request carrying only the
   * job's prompt, the run's own tool log, the final answer as the run's output, and the container
   * destroyed before the processor returns.
   */
  it('runs a tick in a fresh workspace and destroys it', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
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
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
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
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const tick = Date.parse('2026-02-01T09:00:00.000Z');

    await run(container, delivery(job.id, 'MANUAL', { timestamp: tick }));

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs[0]).toMatchObject({ trigger: 'MANUAL', scheduledFor: new Date(tick) });
  });

  /**
   * The prompt and the request are two descriptions of one run, and the agent obeys both. A prompt
   * naming the job's branch as the place to push, next to a sentence forbidding a push there, is
   * an instruction the agent cannot follow.
   */
  it('names one work branch in the prompt and in the request', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    const request = (await requestSentTo(container)) as {
      instructions: string;
      repo: { workBranch: string; baseBranch: string };
    };
    expect(request.repo.workBranch).not.toBe(request.repo.baseBranch);
    expect(request.instructions).toContain(
      `push your work to the branch ${request.repo.workBranch}`,
    );
    expect(request.instructions).toContain(`to ${request.repo.baseBranch} and never force-push`);
  });

  /**
   * A failure the runtime reported is recorded on the run, and the container is destroyed anyway.
   */
  it('records a reported failure and still destroys the workspace', async () => {
    const container = setupProcessorContainer({
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
    const container = setupProcessorContainer({
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
   * A manual run can be stopped while its container is still being built, and that request reaches
   * a worker that is already listening. Nothing is executed, the run is recorded as cancelled, and
   * the workspace that was created for it is destroyed like any other.
   */
  it('cancels a run stopped while its workspace was being prepared', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const manual = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });
    const setStatus = container.repos.jobRuns.setStatus.bind(container.repos.jobRuns);
    vi.spyOn(container.repos.jobRuns, 'setStatus').mockImplementation(
      async (id, status, update) => {
        const row = await setStatus(id, status, update);
        if (status === 'PREPARING') {
          container.commands.emitCancel(id);
        }
        return row;
      },
    );

    await run(container, delivery(job.id, 'MANUAL', { runId: manual.id }));

    expect((await container.repos.jobRuns.get(manual.id))?.status).toBe('CANCELLED');
    expect(container.publisher.eventsFor(manual.id).at(-1)).toEqual({ type: 'turn.cancelled' });
    expect(container.runner.calls).toHaveLength(0);
    expect(container.commands.subscriptions).toBe(0);
    vi.restoreAllMocks();
  });

  /**
   * The gap this fix closes: a manual run's id already exists when this delivery is read — the
   * API created its row and answered the request with it before the job was ever enqueued — so a
   * Stop pressed while the worker is still looking up the job row must already find a subscriber.
   * Emitting the cancellation from inside that very lookup, well before the workspace would be
   * built, proves the watch opened ahead of the first database read rather than merely ahead of
   * provisioning.
   */
  it('cancels a manual run stopped before the worker reads the job row', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const manual = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });
    const getJob = container.repos.scheduledJobs.get.bind(container.repos.scheduledJobs);
    vi.spyOn(container.repos.scheduledJobs, 'get').mockImplementation(async (id) => {
      // A subscriber must already be in place for this to reach anyone: with the watch opened
      // only after this lookup, as it used to be, nothing is listening yet and this returns
      // `false`, and the run below finishes `SUCCEEDED` instead of `CANCELLED`.
      const reached = container.commands.emitCancel(manual.id);
      expect(reached).toBe(true);
      return getJob(id);
    });

    await run(container, delivery(job.id, 'MANUAL', { runId: manual.id }));

    expect((await container.repos.jobRuns.get(manual.id))?.status).toBe('CANCELLED');
    expect(container.runner.calls).toHaveLength(0);
    vi.restoreAllMocks();
  });

  /**
   * The early watch is opened on the delivery's own `runId`, but `openRun` mints a fresh row under
   * a fresh id whenever that named run cannot be adopted (see
   * `run-scheduled-job-deliveries.test.ts`'s "opens a fresh run..." case). A cancellation must
   * follow the identity that is actually about to run, not the one the delivery happened to name:
   * emitting it against the fresh row's id — never against the bogus one the early watch first
   * opened on — is what a real Stop click would target, because that fresh id is the only one the
   * UI ever learns about.
   */
  it('cancels the fresh run opened when the named run could not be adopted', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const setStatus = container.repos.jobRuns.setStatus.bind(container.repos.jobRuns);
    vi.spyOn(container.repos.jobRuns, 'setStatus').mockImplementation(
      async (id, status, update) => {
        const row = await setStatus(id, status, update);
        if (status === 'PREPARING') {
          // `id` is the fresh row `openRun` minted for this delivery, not the bogus id the
          // delivery named — reaching it here proves the operative watch tracked the identity
          // that changed rather than the one the early subscription first opened on.
          expect(container.commands.emitCancel(id)).toBe(true);
        }
        return row;
      },
    );

    await run(container, delivery(job.id, 'MANUAL', { runId: 'no-such-run' }));

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('CANCELLED');
    expect(container.runner.calls).toHaveLength(0);
    expect(container.commands.subscriptions).toBe(0);
    vi.restoreAllMocks();
  });

  /**
   * Provisioning is the slow part the user is watching, so it is where Stop is pressed — and the
   * two ways out of it must agree. A cancellation arriving while the container is built is honoured
   * by the executor, which seeds its state from the same watch; one arriving while the build fails
   * must be honoured too, instead of recording the build failure over an answer the cancel route
   * already gave. The Stop is emitted from the workspace row provisioning opens, which is after the
   * check made before preparation and before the failure is written.
   */
  it('cancels a run stopped while the workspace it never got was failing', async () => {
    const container = setupProcessorContainer({ runner: (opts) => new ImagelessRunner(opts) });
    const job = await seedJob(container);
    const manual = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });
    const create = container.repos.workspaces.create.bind(container.repos.workspaces);
    vi.spyOn(container.repos.workspaces, 'create').mockImplementation(async (input) => {
      const row = await create(input);
      expect(container.commands.emitCancel(manual.id)).toBe(true);
      return row;
    });

    await run(container, delivery(job.id, 'MANUAL', { runId: manual.id }));
    vi.restoreAllMocks();

    const closed = await container.repos.jobRuns.get(manual.id);
    expect(closed?.status).toBe('CANCELLED');
    expect(closed?.error).toBeNull();
    expect(container.publisher.eventsFor(manual.id).at(-1)).toEqual({ type: 'turn.cancelled' });
    expect([...container.repos.store.workspaces.values()][0]?.status).toBe('FAILED');
  });

  /**
   * A run cancelled while the runtime ignores the signal is still recorded as cancelled, and its
   * container is still destroyed.
   */
  it('closes out a cancellation the runtime never acknowledged', async () => {
    const container = setupProcessorContainer({
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
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
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
    const container = setupProcessorContainer({ script: scriptedRuntime([], { exitCode: 3 }) });
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
    const container = setupProcessorContainer({
      secrets: new FakeSecretsService({ GITHUB_PAT: GITHUB_CANARY }),
    });
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
    const container = setupProcessorContainer({
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
    const container = setupProcessorContainer({
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
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
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
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
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
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
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
    const container = setupProcessorContainer({
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
