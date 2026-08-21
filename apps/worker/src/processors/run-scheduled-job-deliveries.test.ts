/**
 * Unit tests for which run a delivery of `run-scheduled-job` is entitled to drive.
 *
 * Layer: unit.
 * Goal: the second guarantee of spec 04 (c) — a tick that fires while the previous run is still
 * executing is recorded rather than queued — and the two things that guarantee must not swallow:
 * a run a dead worker abandoned, which a redelivery recovers instead of skipping for ever, and a
 * manual run this delivery may or may not adopt. The run lifecycle itself is the subject of
 * `run-scheduled-job.test.ts`.
 * Mocks: the shared processor fixtures over in-memory repositories and the fake runner.
 */
import { OVERLAP_SKIP_REASON } from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import {
  destroyedHandles,
  FIXTURE_REPO_URL,
  happyJobScript as happyScript,
  jobDelivery as delivery,
  runScheduledJobOn as run,
  scriptedRuntime,
  seedJob,
  setupProcessorContainer,
} from '../testing/index.js';

import {
  JOB_DISABLED_CODE,
  JOB_MISSING_CODE,
  STALLED_RUN_CODE,
  STALLED_RUN_MESSAGE,
  STALLED_RUN_REASON,
} from './constants.js';
import { IneligibleRunError } from './run-scheduled-job-deliveries.js';

describe('createRunScheduledJobProcessor, which run a delivery drives', () => {
  /**
   * A tick that fires while the previous run is still executing is recorded as a failure and does
   * nothing else: no container, and no change to the run times the executing run owns.
   */
  it('records an overlapping tick without starting a container', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
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
    const skipped = runs.find((entry) => entry.id !== running.id);
    expect(skipped?.status).toBe('FAILED');
    expect(skipped?.error).toContain(OVERLAP_SKIP_REASON);
    expect(container.runner.calls).toHaveLength(0);
    expect((await container.repos.scheduledJobs.get(job.id))?.lastRunAt).toBeNull();
  });

  /**
   * The leak the boot pass used to answer, answered where it belongs instead. A run records the
   * workspace before it takes it, so a process dying between those two writes still leaves the
   * stalled-run recovery a handle on the row — the run's `workspaceId` is the only link there is,
   * because the row carries no reference back to its run.
   */
  it('recovers a workspace whose run died between recording it and taking it', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const abandoned = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'test-model',
      scheduledFor: container.clock.now(),
    });
    const workspace = await container.repos.workspaces.create({
      kind: 'JOB',
      runnerKind: 'fake',
      image: 'image',
      repoUrl: FIXTURE_REPO_URL,
      branch: 'master',
    });
    await container.repos.workspaces.setStatus(workspace.id, 'READY', { runnerRef: 'ref-dead' });
    await container.repos.jobRuns.setStatus(abandoned.id, 'PREPARING', {
      workspaceId: workspace.id,
    });
    await container.repos.workspaces.claimStatus(workspace.id, 'READY', 'BUSY');

    await run(container, delivery(job.id, 'SCHEDULE', { stalledCounter: 1 }));

    expect(await container.repos.workspaces.get(workspace.id)).toMatchObject({
      status: 'DESTROYED',
      failureReason: STALLED_RUN_REASON,
    });
    expect((await container.repos.jobRuns.get(abandoned.id))?.status).toBe('FAILED');
  });

  /**
   * The other side of recording it early: a run that never took the workspace must not destroy it.
   * The collector won the race for this one and owns both the row and the container, so the
   * abandoned run's recovery leaves them alone — `BUSY` is what says "this run took it".
   */
  it('does not destroy a workspace its run recorded but never took', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const abandoned = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'test-model',
      scheduledFor: container.clock.now(),
    });
    const workspace = await container.repos.workspaces.create({
      kind: 'JOB',
      runnerKind: 'fake',
      image: 'image',
      repoUrl: FIXTURE_REPO_URL,
      branch: 'master',
    });
    await container.repos.workspaces.setStatus(workspace.id, 'READY', { runnerRef: 'ref-taken' });
    await container.repos.jobRuns.setStatus(abandoned.id, 'PREPARING', {
      workspaceId: workspace.id,
    });
    // The collector got there first and is committed to destroying the container.
    await container.repos.workspaces.claimStatus(workspace.id, 'READY', 'STOPPING');

    await run(container, delivery(job.id, 'SCHEDULE', { stalledCounter: 1 }));

    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('STOPPING');
    expect(destroyedHandles(container).some((handle) => handle.runnerRef === 'ref-taken')).toBe(
      false,
    );
  });

  /**
   * A worker that dies mid-run leaves its `JobRun` in `RUNNING` and its workspace in `BUSY`, and
   * nothing else reclaims either: the collector reconciles only `READY` and `STOPPING` rows, and
   * orphan reconciliation leaves a container alone while a live row points at it. Treating that
   * abandoned row as an overlap would make every later tick skip for ever and leak one container
   * per crash, so the redelivery closes its predecessor out and then runs the tick.
   */
  it('recovers the run an earlier delivery abandoned instead of skipping as overlapping', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const abandoned = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'test-model',
      scheduledFor: container.clock.now(),
    });
    const workspace = await container.repos.workspaces.create({
      kind: 'JOB',
      runnerKind: 'fake',
      image: 'image',
      repoUrl: FIXTURE_REPO_URL,
      branch: 'master',
    });
    await container.repos.workspaces.setStatus(workspace.id, 'READY', { runnerRef: 'ref-dead' });
    await container.repos.workspaces.setStatus(workspace.id, 'BUSY');
    await container.repos.jobRuns.setStatus(abandoned.id, 'RUNNING', { workspaceId: workspace.id });

    await run(container, delivery(job.id, 'SCHEDULE', { stalledCounter: 1 }));

    const closed = await container.repos.jobRuns.get(abandoned.id);
    expect(closed?.status).toBe('FAILED');
    expect(closed?.error).toContain(STALLED_RUN_CODE);
    expect(container.publisher.eventsFor(abandoned.id).at(-1)).toMatchObject({
      type: 'turn.failed',
    });
    expect(await container.repos.workspaces.get(workspace.id)).toMatchObject({
      status: 'DESTROYED',
      failureReason: STALLED_RUN_REASON,
    });
    expect(destroyedHandles(container).some((handle) => handle.runnerRef === 'ref-dead')).toBe(
      true,
    );

    const runs = await container.repos.jobRuns.listByJob(job.id);
    const fresh = runs.find((entry) => entry.id !== abandoned.id);
    expect(fresh?.status).toBe('SUCCEEDED');
  });

  /**
   * The other half of the same rule: a delivery BullMQ never recovered from the stalled set has no
   * abandoned predecessor, so a run it finds executing is genuinely executing and the tick is
   * still recorded as overlapping rather than trampling it.
   */
  it('still skips an overlapping tick when the delivery never stalled', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const running = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'test-model',
      scheduledFor: container.clock.now(),
    });
    await container.repos.jobRuns.setStatus(running.id, 'RUNNING');

    await run(container, delivery(job.id, 'SCHEDULE', { stalledCounter: 0 }));

    expect((await container.repos.jobRuns.get(running.id))?.status).toBe('RUNNING');
    expect(container.publisher.eventsFor(running.id)).toHaveLength(0);
    expect(container.runner.calls).toHaveLength(0);
  });

  /**
   * A predecessor that got far enough to close its own workspace out leaves a terminal row, and a
   * recovery must not destroy a container twice or walk a row back out of a status the lifecycle
   * forbids leaving.
   */
  it('recovers an abandoned run whose workspace is already closed out', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const abandoned = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'test-model',
      scheduledFor: container.clock.now(),
    });
    const workspace = await container.repos.workspaces.create({
      kind: 'JOB',
      runnerKind: 'fake',
      image: 'image',
      repoUrl: FIXTURE_REPO_URL,
      branch: 'master',
    });
    await container.repos.workspaces.setStatus(workspace.id, 'DESTROYED');
    await container.repos.jobRuns.setStatus(abandoned.id, 'RUNNING', { workspaceId: workspace.id });

    await run(container, delivery(job.id, 'SCHEDULE', { stalledCounter: 1 }));

    expect((await container.repos.jobRuns.get(abandoned.id))?.status).toBe('FAILED');
    expect(destroyedHandles(container).some((handle) => handle.workspaceId === workspace.id)).toBe(
      false,
    );
  });

  /**
   * A run abandoned before it ever reached a container has no workspace to reclaim; it is still
   * closed out so the job is not blocked for ever.
   */
  it('recovers an abandoned run that never got a workspace', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const abandoned = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'test-model',
      scheduledFor: container.clock.now(),
    });
    await container.repos.jobRuns.setStatus(abandoned.id, 'PREPARING');

    await run(container, delivery(job.id, 'SCHEDULE', { stalledCounter: 1 }));

    expect((await container.repos.jobRuns.get(abandoned.id))?.status).toBe('FAILED');
    expect(container.logs.join('')).toContain('recovering a run whose worker stopped');
  });

  /**
   * A worker that died during provisioning leaves a `CREATING` row that never recorded a container
   * reference. The row is still live, so the recovery closes it out — with an empty reference,
   * which the runner reports as gone rather than mistaking for another container.
   */
  it('recovers an abandoned run whose container was never reported', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const abandoned = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'test-model',
      scheduledFor: container.clock.now(),
    });
    const creating = await container.repos.workspaces.create({
      kind: 'JOB',
      runnerKind: 'fake',
      image: 'image',
      repoUrl: FIXTURE_REPO_URL,
      branch: 'master',
    });
    await container.repos.jobRuns.setStatus(abandoned.id, 'RUNNING', { workspaceId: creating.id });

    await run(container, delivery(job.id, 'SCHEDULE', { stalledCounter: 1 }));

    expect((await container.repos.jobRuns.get(abandoned.id))?.status).toBe('FAILED');
    expect(await container.repos.workspaces.get(creating.id)).toMatchObject({
      status: 'DESTROYED',
      runnerRef: null,
    });
  });

  /**
   * A daemon that refuses to remove the abandoned container must not stop the recovery: the row is
   * still closed out, so the job runs again instead of being blocked by a container nobody can
   * remove.
   */
  it('recovers an abandoned run whose container cannot be destroyed', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const abandoned = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'test-model',
      scheduledFor: container.clock.now(),
    });
    const workspace = await container.repos.workspaces.create({
      kind: 'JOB',
      runnerKind: 'fake',
      image: 'image',
      repoUrl: FIXTURE_REPO_URL,
      branch: 'master',
    });
    await container.repos.workspaces.setStatus(workspace.id, 'READY', { runnerRef: 'ref-stuck' });
    await container.repos.jobRuns.setStatus(abandoned.id, 'RUNNING', { workspaceId: workspace.id });
    vi.spyOn(container.runner, 'destroy').mockRejectedValueOnce(new Error('daemon busy'));

    await run(container, delivery(job.id, 'SCHEDULE', { stalledCounter: 1 }));

    expect((await container.repos.jobRuns.get(abandoned.id))?.status).toBe('FAILED');
    expect((await container.repos.workspaces.get(workspace.id))?.status).toBe('DESTROYED');
    expect(container.logs.join('')).toContain(
      'destroying the workspace of an abandoned run failed',
    );
    vi.restoreAllMocks();
  });

  /**
   * A manual run has a browser attached to its stream from the moment the API answered with its
   * id. Dropping it as overlapping is still an outcome, and a run finished without a terminal
   * event leaves that page waiting for one nobody is going to send.
   */
  it('ends the stream of a manual run it dropped as overlapping', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const running = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'test-model',
      scheduledFor: container.clock.now(),
    });
    await container.repos.jobRuns.setStatus(running.id, 'RUNNING');
    const manual = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });

    await run(container, delivery(job.id, 'MANUAL', { runId: manual.id }));

    expect(container.publisher.eventsFor(manual.id).at(-1)).toMatchObject({ type: 'turn.failed' });
    const dropped = await container.repos.jobRuns.get(manual.id);
    expect(dropped?.status).toBe('FAILED');
    expect(dropped?.error).toContain(OVERLAP_SKIP_REASON);
    expect(container.runner.calls).toHaveLength(0);
  });

  /**
   * A manual run already has its row: the API answered the request with its id and the browser is
   * watching that run's stream, so a second row would leave the page watching nothing.
   */
  it('adopts the run a manual delivery names', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const existing = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });

    await run(container, delivery(job.id, 'MANUAL', { runId: existing.id }));

    const runs = await container.repos.jobRuns.listByJob(job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: existing.id, status: 'SUCCEEDED' });
    expect(container.publisher.eventsFor(existing.id).length).toBeGreaterThan(0);
  });

  /**
   * A delivery may only drive the run it was created for. A row belonging to another job is that
   * job's historical record, and writing this delivery's outcome, workspace and tool log onto it
   * would overwrite a run nobody asked to re-run.
   */
  it('refuses a delivery naming a run of another job', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const other = await seedJob(container);
    const foreign = await container.repos.jobRuns.create({
      jobId: other.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });

    await expect(run(container, delivery(job.id, 'MANUAL', { runId: foreign.id }))).rejects.toThrow(
      IneligibleRunError,
    );

    expect((await container.repos.jobRuns.get(foreign.id))?.status).toBe('QUEUED');
    expect(await container.repos.jobRuns.listByJob(job.id)).toHaveLength(0);
    expect(container.runner.calls).toHaveLength(0);
    expect(container.logs.join('')).toContain('delivery names a run it may not adopt');
  });

  /**
   * Only a manual run has a row before its delivery arrives. A delivery pointing at a scheduled
   * run is pointing at a record that was opened by a tick, not for it.
   */
  it('refuses a delivery naming a scheduled run', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const scheduled = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });

    await expect(
      run(container, delivery(job.id, 'MANUAL', { runId: scheduled.id })),
    ).rejects.toThrow(IneligibleRunError);

    expect((await container.repos.jobRuns.get(scheduled.id))?.status).toBe('QUEUED');
    expect(container.runner.calls).toHaveLength(0);
  });

  /**
   * The API leaves a manual run `QUEUED`, so anything else means the delivery is a duplicate of
   * one already in flight or a redelivery of one that finished. Neither may reopen the row: the
   * first would run the same job twice against one record, the second would erase its outcome.
   */
  it('refuses a delivery naming a run that already started', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);
    const started = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });
    await container.repos.jobRuns.setStatus(started.id, 'RUNNING');

    await expect(run(container, delivery(job.id, 'MANUAL', { runId: started.id }))).rejects.toThrow(
      IneligibleRunError,
    );

    expect((await container.repos.jobRuns.get(started.id))?.status).toBe('RUNNING');
    expect(container.runner.calls).toHaveLength(0);
    expect(container.publisher.records).toHaveLength(0);
  });

  /**
   * A named run that has since been deleted must not drop the delivery: the tick still happened,
   * so it is recorded against a fresh row.
   */
  it('opens a fresh run when the one it was told to adopt is gone', async () => {
    const container = setupProcessorContainer({ script: scriptedRuntime(happyScript()) });
    const job = await seedJob(container);

    await run(container, delivery(job.id, 'MANUAL', { runId: 'no-such-run' }));

    expect(await container.repos.jobRuns.listByJob(job.id)).toHaveLength(1);
    expect(container.logs.join('')).toContain('run to adopt is gone');
  });

  /**
   * A job that was deleted, or disabled since the scheduler was registered, is acknowledged and
   * nothing is recorded: a disabled job that still ran would be a surprise the UI cannot explain.
   */
  it('skips a job that is gone or disabled', async () => {
    const container = setupProcessorContainer();
    const disabled = await seedJob(container, { enabled: false });

    await run(container, delivery('no-such-job'));
    await run(container, delivery(disabled.id));

    expect(await container.repos.jobRuns.listByJob(disabled.id)).toHaveLength(0);
    expect(container.runner.calls).toHaveLength(0);
    expect(container.logs.join('')).toContain('scheduled job is disabled');
  });

  /**
   * A manual run already owns a row and a browser is watching its stream. If the job is disabled
   * between the request and the delivery, returning without touching that row would leave it
   * `QUEUED` for good and the page waiting for a terminal event nobody will send.
   */
  it('fails the manual run of a job that was disabled meanwhile', async () => {
    const container = setupProcessorContainer();
    const job = await seedJob(container, { enabled: false });
    const manual = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });

    await run(container, delivery(job.id, 'MANUAL', { runId: manual.id }));

    const closed = await container.repos.jobRuns.get(manual.id);
    expect(closed?.status).toBe('FAILED');
    expect(closed?.error).toContain(JOB_DISABLED_CODE);
    expect(container.publisher.eventsFor(manual.id).at(-1)).toMatchObject({ type: 'turn.failed' });
    expect(container.runner.calls).toHaveLength(0);
  });

  /**
   * The same holds when the job was deleted rather than disabled: the run it left behind is closed
   * out instead of watched forever.
   */
  it('fails the manual run of a job that is gone', async () => {
    const container = setupProcessorContainer();
    const job = await seedJob(container);
    const manual = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });
    container.repos.store.scheduledJobs.delete(job.id);

    await run(container, delivery(job.id, 'MANUAL', { runId: manual.id }));

    const closed = await container.repos.jobRuns.get(manual.id);
    expect(closed?.status).toBe('FAILED');
    expect(closed?.error).toContain(JOB_MISSING_CODE);
    expect(container.publisher.eventsFor(manual.id).at(-1)).toMatchObject({ type: 'turn.failed' });
  });

  /**
   * Closing an unrunnable run obeys the same eligibility rule as adopting one. A row that belongs
   * to another job, or one this delivery never opened, is somebody else's record: a stale delivery
   * naming it must not terminalise it, and a delivery naming a row that no longer exists has
   * nothing to close.
   */
  it('leaves a run it may not adopt alone when the job is unavailable', async () => {
    const container = setupProcessorContainer();
    const disabled = await seedJob(container, { enabled: false });
    const other = await seedJob(container);
    const foreign = await container.repos.jobRuns.create({
      jobId: other.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });

    await run(container, delivery(disabled.id, 'MANUAL', { runId: foreign.id }));
    await run(container, delivery(disabled.id, 'MANUAL', { runId: 'no-such-run' }));

    expect((await container.repos.jobRuns.get(foreign.id))?.status).toBe('QUEUED');
    expect(container.publisher.records).toHaveLength(0);
  });

  /**
   * A manual run can be stopped in the window between the delivery being read and the overlap being
   * decided, and `POST /api/runs/:id/cancel` answers `202` to that Stop — a promise about this very
   * row. Dropping the tick as overlapping is still the right thing to do with the container that
   * never gets built, but the record the user is shown must be the cancellation they asked for,
   * not a failure they did not cause. The Stop is emitted from inside the job lookup so it reaches
   * the subscription the consumer opened before its first read.
   */
  it('cancels a manual run stopped before its overlapping tick was dropped', async () => {
    const container = setupProcessorContainer();
    const job = await seedJob(container);
    const running = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });
    await container.repos.jobRuns.setStatus(running.id, 'RUNNING');
    const manual = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });
    const getJob = container.repos.scheduledJobs.get.bind(container.repos.scheduledJobs);
    vi.spyOn(container.repos.scheduledJobs, 'get').mockImplementation(async (id) => {
      expect(container.commands.emitCancel(manual.id)).toBe(true);
      return getJob(id);
    });

    await run(container, delivery(job.id, 'MANUAL', { runId: manual.id }));
    vi.restoreAllMocks();

    const closed = await container.repos.jobRuns.get(manual.id);
    expect(closed?.status).toBe('CANCELLED');
    expect(closed?.error).toBeNull();
    expect(container.publisher.eventsFor(manual.id)).toEqual([{ type: 'turn.cancelled' }]);
    expect(container.runner.calls).toHaveLength(0);
    // The run that is still executing keeps the run times, exactly as when the tick is failed.
    expect((await container.repos.jobRuns.get(running.id))?.status).toBe('RUNNING');
    expect((await container.repos.scheduledJobs.get(job.id))?.lastRunAt).toBeNull();
    expect(container.commands.subscriptions).toBe(0);
  });

  /**
   * The same promise binds the branch that closes a manual run whose job was disabled meanwhile.
   * Two things are true at once — the user pressed Stop and the job could not have run — and the
   * row records the instruction, because the reason is already on the worker log while nothing
   * else anywhere records that the user asked.
   */
  it('cancels the manual run of a disabled job when the user stopped it first', async () => {
    const container = setupProcessorContainer();
    const job = await seedJob(container, { enabled: false });
    const manual = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });
    const getJob = container.repos.scheduledJobs.get.bind(container.repos.scheduledJobs);
    vi.spyOn(container.repos.scheduledJobs, 'get').mockImplementation(async (id) => {
      expect(container.commands.emitCancel(manual.id)).toBe(true);
      return getJob(id);
    });

    await run(container, delivery(job.id, 'MANUAL', { runId: manual.id }));
    vi.restoreAllMocks();

    const closed = await container.repos.jobRuns.get(manual.id);
    expect(closed?.status).toBe('CANCELLED');
    expect(closed?.error).toBeNull();
    expect(container.publisher.eventsFor(manual.id)).toEqual([{ type: 'turn.cancelled' }]);
    expect(container.logs.join('')).toContain('scheduled job is disabled');
  });

  /**
   * And the branch that closes a manual run whose job was deleted meanwhile, for the same reason.
   * The job row is gone before the lookup answers, so the delivery has nothing left to run and the
   * Stop is the only thing left to record.
   */
  it('cancels the manual run of a deleted job when the user stopped it first', async () => {
    const container = setupProcessorContainer();
    const job = await seedJob(container);
    const manual = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });
    container.repos.store.scheduledJobs.delete(job.id);
    const getJob = container.repos.scheduledJobs.get.bind(container.repos.scheduledJobs);
    vi.spyOn(container.repos.scheduledJobs, 'get').mockImplementation(async (id) => {
      expect(container.commands.emitCancel(manual.id)).toBe(true);
      return getJob(id);
    });

    await run(container, delivery(job.id, 'MANUAL', { runId: manual.id }));
    vi.restoreAllMocks();

    const closed = await container.repos.jobRuns.get(manual.id);
    expect(closed?.status).toBe('CANCELLED');
    expect(closed?.error).toBeNull();
    expect(container.publisher.eventsFor(manual.id)).toEqual([{ type: 'turn.cancelled' }]);
    expect(container.logs.join('')).toContain('scheduled job is gone');
  });

  /**
   * A cancellation reaches this delivery's own watch, and the run a dead worker abandoned is not
   * the run that watch is for: nothing ever subscribed on its behalf here, and the subscription
   * that did died with its worker. Recovering it stays a failure, so the delivery cannot invent a
   * Stop the abandoned run's user never made — while the run this delivery drives still honours
   * the one that was made.
   */
  it('recovers an abandoned run as failed even while its successor is being cancelled', async () => {
    const container = setupProcessorContainer();
    const job = await seedJob(container);
    const abandoned = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });
    await container.repos.jobRuns.setStatus(abandoned.id, 'RUNNING');
    const manual = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });
    const getJob = container.repos.scheduledJobs.get.bind(container.repos.scheduledJobs);
    vi.spyOn(container.repos.scheduledJobs, 'get').mockImplementation(async (id) => {
      expect(container.commands.emitCancel(manual.id)).toBe(true);
      return getJob(id);
    });

    await run(container, delivery(job.id, 'MANUAL', { runId: manual.id, stalledCounter: 1 }));
    vi.restoreAllMocks();

    const recovered = await container.repos.jobRuns.get(abandoned.id);
    expect(recovered?.status).toBe('FAILED');
    expect(recovered?.error).toContain(STALLED_RUN_CODE);
    expect(container.publisher.eventsFor(abandoned.id)).toEqual([
      { type: 'turn.failed', error: { code: STALLED_RUN_CODE, message: STALLED_RUN_MESSAGE } },
    ]);
    expect((await container.repos.jobRuns.get(manual.id))?.status).toBe('CANCELLED');
  });
});
