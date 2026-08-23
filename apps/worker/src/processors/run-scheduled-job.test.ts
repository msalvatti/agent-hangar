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
import { DEFAULT_JOB_TURN_LIMITS, JOB_NAMES, nextRunAt, NotFoundError } from '@agent-hangar/core';
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
    // Both identifiers on the line: which run lost its container, and which container it lost. The
    // collector is about to destroy that one, and this is the only place the two are named
    // together.
    expect(
      container.logs.map((line) => JSON.parse(line) as Record<string, unknown>),
    ).toContainEqual(
      expect.objectContaining({
        msg: 'the workspace this run provisioned was reclaimed before it could be used',
        runId: runs[0]?.id,
        workspaceId: runs[0]?.workspaceId,
      }),
    );
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
   * A run's container is destroyed the moment it finishes and its event stream is discarded an hour
   * later, so the branch the run pushed to is on the run's own row or it is nowhere. That branch is
   * the whole product of a scheduled coding job, and the operator reads it long after both the
   * container and the stream are gone.
   */
  it('keeps nothing from the live-view events, and counts the highest step it saw', async () => {
    const container = setupProcessorContainer({
      script: scriptedRuntime([
        { type: 'turn.started', turnId: 'ignored', at: '2026-01-01T00:00:00.000Z' },
        { type: 'prepare.progress', message: 'Cloning…' },
        { type: 'prepare.done', headSha: 'abc1234', branch: 'master' },
        { type: 'heartbeat', at: '2026-01-01T00:00:01.000Z' },
        { type: 'assistant.delta', text: 'thinking' },
        { type: 'assistant.message', text: 'done thinking' },
        { type: 'protocol.error', reason: 'schema-violation', length: 42 },
        { type: 'step.started', step: 3 },
        { type: 'step.started', step: 2 },
        { type: 'turn.failed', error: { code: 'runtime_exit', message: 'the runtime gave up' } },
      ]),
    });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    // Every one of those events is named in the sink: the seven above are deliberately kept
    // nowhere, and a delivery that reached the end without recognising one of them would have
    // dropped something the runtime sent it.
    const [record] = await container.repos.jobRuns.listByJob(job.id);
    expect(record).toMatchObject({
      status: 'FAILED',
      error: 'runtime_exit: the runtime gave up',
      // The highest step reached, not the last one reported. Steps can arrive out of order when a
      // step ends after the next begins, and a count that took the latest would report a run that
      // did three steps as having done two.
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 3,
      output: null,
    });
  });

  it('records where the run pushed', async () => {
    const script = happyScript();
    script.splice(script.length - 1, 0, {
      type: 'git.pushed',
      branch: 'agent/job-2f7c11a0',
      sha: 'c0ffee1234567890abcdef',
    });
    const container = setupProcessorContainer({ script: scriptedRuntime(script) });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs[0]).toMatchObject({
      status: 'SUCCEEDED',
      workBranch: 'agent/job-2f7c11a0',
      lastPushedSha: 'c0ffee1234567890abcdef',
    });
  });

  /**
   * A run that pushed twice is described by the second push: the first branch may no longer be
   * where its work is, and a record of both would say nothing about which one to look at.
   */
  it('keeps the last push of a run that pushed twice', async () => {
    const script = happyScript();
    script.splice(
      script.length - 1,
      0,
      { type: 'git.pushed', branch: 'agent/job-first', sha: '1111111111111111' },
      { type: 'git.pushed', branch: 'agent/job-second', sha: '2222222222222222' },
    );
    const container = setupProcessorContainer({ script: scriptedRuntime(script) });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs[0]).toMatchObject({
      workBranch: 'agent/job-second',
      lastPushedSha: '2222222222222222',
    });
  });

  /**
   * A run that pushed nothing says so, rather than carrying a branch it never wrote to.
   */
  it('leaves the push record empty when the run pushed nothing', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs[0]).toMatchObject({ workBranch: null, lastPushedSha: null });
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
   * A delivery that carries no timestamp is stamped with now. BullMQ supplies one for a scheduled
   * tick; a delivery made by hand may not, and a run stamped from a timestamp that is not there is
   * stamped `Invalid Date` — a row the UI cannot order and the schedule cannot be read from.
   */
  it('opens one subscription for a tick, on the run it just created', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    // A tick has no run to listen for until it has opened one, so nothing is subscribed before
    // that. A watch opened earlier would be listening on a channel named after no run at all —
    // a Stop for the run this delivery goes on to create would land nowhere.
    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(container.commands.subscribed).toStrictEqual([runs[0]?.id]);
    expect(container.commands.closed).toStrictEqual([runs[0]?.id]);
    expect(container.commands.subscriptions).toBe(0);
  });

  /**
   * A manual delivery listens from the moment it is parsed, because the run row already exists and
   * a Stop may arrive before the job row has even been read. That one subscription is reused for
   * the run and closed exactly once: closed twice, a shared connection is told to unsubscribe from
   * a channel it is no longer on, once per delivery.
   */
  it('reuses the manual run’s early subscription and closes it once', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const manual = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });

    await run(container, delivery(job.id, 'MANUAL', { runId: manual.id }));

    expect(container.commands.subscribed).toStrictEqual([manual.id]);
    expect(container.commands.closed).toStrictEqual([manual.id]);
    expect(container.commands.subscriptions).toBe(0);
  });

  it('stamps a delivery with no timestamp of its own with the current time', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);

    await run(container, delivery(job.id));

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs[0]?.scheduledFor).toStrictEqual(container.clock.now());
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

    // The steps it got through are recorded even though the run was cut short: a cancelled run's
    // cost is what it did before the Stop, and a row carrying no usage at all reads as a run that
    // never started.
    expect((await container.repos.jobRuns.listByJob(job.id))[0]).toMatchObject({
      status: 'CANCELLED',
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });
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
   * A terminal run status does not mean this processor has finished with the run: the outcome is
   * written while the container is still up, and the teardown that follows destroys it, marks the
   * workspace `DESTROYED` and records the run times. A caller that waits for the status and then
   * deletes the job — which the API allows the moment the run is terminal — therefore lands in the
   * middle of that teardown. The delete is driven from inside the teardown itself, at the
   * workspace write that genuinely precedes the run-times update, so the window is the real one.
   * Before, the run-times write raised on the row that was no longer there and failed the whole
   * delivery over a sequence the API permits.
   */
  it('survives the job being deleted while its run is torn down', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const setStatus = container.repos.workspaces.setStatus.bind(container.repos.workspaces);
    let deleted = false;
    vi.spyOn(container.repos.workspaces, 'setStatus').mockImplementation(
      async (id, status, update) => {
        const written = await setStatus(id, status, update);
        if (status === 'DESTROYED' && !deleted) {
          deleted = true;
          await container.repos.scheduledJobs.delete(job.id);
        }
        return written;
      },
    );

    await expect(run(container, delivery(job.id))).resolves.toBeUndefined();

    expect(await container.repos.scheduledJobs.get(job.id)).toBeNull();
    expect(container.logs.join('')).toContain('scheduled job was deleted while its run');
    vi.restoreAllMocks();
  });

  /**
   * The other side of that branch: a row reported missing under some *other* identifier is not the
   * delete this teardown is willing to absorb, so it still fails the delivery. Comparing the type
   * alone would turn a write that went to the wrong row into a silent success.
   */
  it('still fails when the missing row is not the job being torn down', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    vi.spyOn(container.repos.scheduledJobs, 'setRunTimes').mockRejectedValue(
      new NotFoundError('ScheduledJob', 'some-other-job'),
    );

    await expect(run(container, delivery(job.id))).rejects.toBeInstanceOf(NotFoundError);
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
   * An unreachable daemon fails the job, and the teardown still runs.
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

    expect(
      container.logs.map((line) => JSON.parse(line) as Record<string, unknown>),
    ).toContainEqual(
      expect.objectContaining({
        msg: 'destroying a run workspace failed',
        workspaceId: [...container.repos.store.workspaces.values()][0]?.id,
        err: expect.objectContaining({ message: 'daemon busy' }) as unknown,
      }),
    );
    // And the run keeps the outcome it reached. The teardown writes a failure only for a run that
    // never reached one of its own; over a run that succeeded it would replace the answer the user
    // is waiting for with "the worker stopped".
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
        // A branch name is chosen by the agent, so it is a place a credential can be carried out
        // of the container as surely as a final message is — and it now lands on a column of its
        // own, which is why this case is scripted here rather than left to the output.
        { type: 'git.pushed', branch: `agent/job-${OPENAI_CANARY}`, sha: '1111111111111111' },
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
    expect(runs[0]?.workBranch).toContain('[REDACTED]');
    expect(() => {
      assertNoCanary(JSON.stringify(container.publisher.records));
    }).not.toThrow();
  });
});
