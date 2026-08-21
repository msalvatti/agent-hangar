/** @vitest-environment node */
/**
 * Unit tests for the scheduled-job routes.
 *
 * Layer: unit.
 * Goal: the row and the BullMQ Job Scheduler always agree, the next fire time is the one core
 * computes, and a manual run creates the row the client will stream from.
 * Mocks: the `bullmq` module; the clock is pinned so `nextRunAt` is deterministic.
 */
import {
  JOB_NAMES,
  jobSummary,
  listJobsResponse,
  nextRunAt,
  NotFoundError,
  triggerRunResponse,
} from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import { REPO_URL_NOT_ALLOWED } from '../repo-url';
import { foreignRequest, writeRequest } from '../testing/requests';
import { createTestContainer } from '../testing/test-container';
import type { TestContainer } from '../testing/test-container';

import { createJob, deleteJob, getJob, listJobs, triggerRun, updateJob } from './jobs';

vi.mock('bullmq', () => import('../testing/fake-queue'));

/** Instant every container in this file starts from. */
const NOW = new Date('2026-08-19T10:00:00.000Z');

/** A repository URL the contracts accept. */
const REPO_URL = 'https://github.com/acme/widgets';

/** A valid job definition. */
const JOB_BODY = {
  name: 'Nightly triage',
  cron: '0 3 * * *',
  timezone: 'Europe/Lisbon',
  prompt: 'Triage new issues',
  repoUrl: REPO_URL,
  branch: 'main',
  enabled: true,
};

/**
 * Creates a job through the route.
 *
 * @param harness - The test container.
 * @param body - Overrides of the default definition.
 * @returns The created job summary.
 */
async function seedJob(
  harness: TestContainer,
  body: Partial<typeof JOB_BODY> = {},
): Promise<ReturnType<typeof jobSummary.parse>> {
  const response = await createJob(
    harness.container,
    writeRequest('/api/jobs', 'POST', { ...JOB_BODY, ...body }),
  );
  expect(response.status).toBe(201);
  return jobSummary.parse(await response.json());
}

describe('createJob', () => {
  /**
   * The happy path writes the row, registers the scheduler under the job's own id and reports the
   * next fire time core computed — the same value the worker will reconcile against.
   */
  it('creates the job and registers its scheduler', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);

    expect(job).toMatchObject({ name: 'Nightly triage', enabled: true, lastRunStatus: null });
    expect(job.nextRunAt).toBe(
      nextRunAt({ cron: JOB_BODY.cron, timezone: JOB_BODY.timezone }, NOW).toISOString(),
    );
    expect(harness.doubles.queues.scheduledJobs.schedulers.get(job.id)).toMatchObject({
      pattern: JOB_BODY.cron,
      tz: JOB_BODY.timezone,
      template: { name: JOB_NAMES.runScheduledJob },
    });
  });

  /**
   * A disabled job is a definition without a schedule: no scheduler is registered and there is no
   * next fire time to show.
   */
  it('registers no scheduler for a disabled job', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness, { enabled: false });
    expect(job.nextRunAt).toBeNull();
    expect(harness.doubles.queues.scheduledJobs.schedulers.size).toBe(0);
  });

  /**
   * Cron and timezone are validated by core before anything is written, so an expression that
   * would never fire is refused at the boundary rather than discovered at the first tick.
   */
  it('rejects an invalid cron expression and an unknown timezone', async () => {
    const harness = createTestContainer({ now: NOW });
    const badCron = await createJob(
      harness.container,
      writeRequest('/api/jobs', 'POST', { ...JOB_BODY, cron: '61 * * * *' }),
    );
    expect(badCron.status).toBe(400);
    expect(await badCron.json()).toMatchObject({ error: { code: 'INVALID_CRON' } });

    const badZone = await createJob(
      harness.container,
      writeRequest('/api/jobs', 'POST', { ...JOB_BODY, timezone: 'Mars/Olympus' }),
    );
    expect(badZone.status).toBe(400);
    expect(await harness.doubles.repos.scheduledJobs.list()).toHaveLength(0);
  });

  /**
   * A repository the operator did not allow is refused, and a foreign origin never reaches the
   * body at all. The rejected URL is well-formed on purpose: a malformed one is refused by the
   * contract, which would leave this route green with the allow-list check deleted.
   */
  it('rejects a disallowed repository and a cross-origin request', async () => {
    const harness = createTestContainer({ now: NOW });
    const badRepo = await createJob(
      harness.container,
      writeRequest('/api/jobs', 'POST', { ...JOB_BODY, repoUrl: 'https://evil.example/a/b' }),
    );
    expect(badRepo.status).toBe(400);
    expect(await badRepo.json()).toMatchObject({ error: { code: REPO_URL_NOT_ALLOWED } });

    const foreign = foreignRequest('/api/jobs', 'POST', JOB_BODY);
    expect((await createJob(harness.container, foreign)).status).toBe(403);
    expect(await harness.doubles.repos.scheduledJobs.list()).toHaveLength(0);
  });

  /**
   * If the scheduler cannot be registered the row is removed again: a job that looks enabled but
   * never fires is the failure mode this rollback exists to prevent.
   */
  it('removes the row when the scheduler cannot be registered', async () => {
    const harness = createTestContainer({ now: NOW });
    const queue = harness.doubles.queues.scheduledJobs;
    vi.spyOn(queue, 'upsertJobScheduler').mockRejectedValue(new Error('redis unreachable'));
    const response = await createJob(
      harness.container,
      writeRequest('/api/jobs', 'POST', JOB_BODY),
    );
    expect(response.status).toBe(500);
    expect(await harness.doubles.repos.scheduledJobs.list()).toHaveLength(0);
  });

  /**
   * Both stores failing at once is the one case the compensation cannot repair, so it is reported
   * rather than swallowed: the request still fails with the scheduler's own error, and the log
   * carries the job id an operator needs to reconcile the two halves by hand.
   */
  it('reports a mismatch it could not repair', async () => {
    const harness = createTestContainer({ now: NOW });
    vi.spyOn(harness.doubles.queues.scheduledJobs, 'upsertJobScheduler').mockRejectedValue(
      new Error('redis unreachable'),
    );
    vi.spyOn(harness.doubles.repos.scheduledJobs, 'delete').mockRejectedValue(
      new Error('database unreachable'),
    );

    const response = await createJob(
      harness.container,
      writeRequest('/api/jobs', 'POST', JOB_BODY),
    );

    expect(response.status).toBe(500);
    expect(harness.doubles.logOutput()).toContain('could not undo a partial scheduled-job write');
  });
});

describe('listJobs and getJob', () => {
  /**
   * The list carries the status of each job's most recent run, which is the column the table
   * renders next to the schedule.
   */
  it('lists jobs with their last run status', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    await harness.doubles.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'gpt-test',
      scheduledFor: NOW,
    });
    const body = listJobsResponse.parse(await (await listJobs(harness.container)).json());
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]?.lastRunStatus).toBe('QUEUED');
  });

  /**
   * Reading one job is its own route because the edit form loads a single row; an unknown id is a
   * missing resource.
   */
  it('reads one job and reports an unknown id as missing', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    const found = await getJob(harness.container, writeRequest('/api/jobs', 'GET'), { id: job.id });
    expect(jobSummary.parse(await found.json()).id).toBe(job.id);
    const missing = await getJob(harness.container, writeRequest('/api/jobs', 'GET'), {
      id: 'nope',
    });
    expect(missing.status).toBe(404);
  });
});

describe('updateJob', () => {
  /**
   * Changing the cron re-registers the scheduler under the same key and moves the next fire time,
   * which is what makes editing idempotent rather than additive.
   */
  it('re-registers the scheduler when the schedule changes', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    const response = await updateJob(
      harness.container,
      writeRequest(`/api/jobs/${job.id}`, 'PATCH', { cron: '30 4 * * *' }),
      { id: job.id },
    );
    const updated = jobSummary.parse(await response.json());
    expect(updated.cron).toBe('30 4 * * *');
    expect(updated.nextRunAt).toBe(
      nextRunAt({ cron: '30 4 * * *', timezone: JOB_BODY.timezone }, NOW).toISOString(),
    );
    expect(harness.doubles.queues.scheduledJobs.schedulers.get(job.id)?.pattern).toBe('30 4 * * *');
  });

  /**
   * A field the patch omits keeps its stored value; spreading an absent optional would otherwise
   * blank the prompt the user spent time on.
   */
  it('leaves omitted fields untouched', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    const response = await updateJob(
      harness.container,
      writeRequest(`/api/jobs/${job.id}`, 'PATCH', { name: 'Renamed' }),
      { id: job.id },
    );
    const updated = jobSummary.parse(await response.json());
    expect(updated).toMatchObject({
      name: 'Renamed',
      prompt: JOB_BODY.prompt,
      cron: JOB_BODY.cron,
    });
  });

  /**
   * Disabling stops the schedule at both ends — the row and Redis — and enabling puts it back.
   */
  it('removes the scheduler on disable and restores it on enable', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    const disabled = jobSummary.parse(
      await (
        await updateJob(
          harness.container,
          writeRequest(`/api/jobs/${job.id}`, 'PATCH', { enabled: false }),
          {
            id: job.id,
          },
        )
      ).json(),
    );
    expect(disabled.nextRunAt).toBeNull();
    expect(harness.doubles.queues.scheduledJobs.schedulers.size).toBe(0);

    await updateJob(
      harness.container,
      writeRequest(`/api/jobs/${job.id}`, 'PATCH', { enabled: true }),
      {
        id: job.id,
      },
    );
    expect(harness.doubles.queues.scheduledJobs.schedulers.has(job.id)).toBe(true);
  });

  /**
   * The row is written before Redis is told about it, so a scheduler that refuses the new schedule
   * would otherwise leave the table advertising a cron that never fires. The edit is rolled back to
   * the values the still-registered scheduler describes, which is what keeps the two halves from
   * disagreeing after a failed request.
   */
  it('rolls the row back when the scheduler refuses the new schedule', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    vi.spyOn(harness.doubles.queues.scheduledJobs, 'upsertJobScheduler').mockRejectedValue(
      new Error('redis unreachable'),
    );

    const response = await updateJob(
      harness.container,
      writeRequest(`/api/jobs/${job.id}`, 'PATCH', { cron: '30 4 * * *', name: 'Renamed' }),
      { id: job.id },
    );

    expect(response.status).toBe(500);
    expect(await harness.doubles.repos.scheduledJobs.get(job.id)).toMatchObject({
      cron: JOB_BODY.cron,
      name: JOB_BODY.name,
      enabled: true,
    });
  });

  /**
   * The undo restores a snapshot taken before this request wrote, so it must not run once another
   * edit owns the row. The rule this protects is that a request that failed never reverts a
   * request that succeeded: writing the pre-edit values back over a later edit would lose a change
   * the user was already told had been saved, which is worse than the mismatch the undo repairs.
   */
  it('declines to undo an edit a later write already replaced', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    vi.spyOn(harness.doubles.queues.scheduledJobs, 'upsertJobScheduler').mockImplementation(
      async () => {
        // A second edit commits while this request sits between its row write and its sync.
        await harness.doubles.repos.scheduledJobs.update(job.id, { name: 'The later edit' });
        throw new Error('redis unreachable');
      },
    );

    const response = await updateJob(
      harness.container,
      writeRequest(`/api/jobs/${job.id}`, 'PATCH', { name: 'Renamed' }),
      { id: job.id },
    );

    expect(response.status).toBe(500);
    expect(await harness.doubles.repos.scheduledJobs.get(job.id)).toMatchObject({
      name: 'The later edit',
    });
    expect(harness.doubles.logOutput()).toContain('declined to undo a scheduled-job edit');
  });

  /**
   * A job deleted while an edit was in flight leaves nothing to undo, and the request still fails
   * with the error that explains it rather than with a second one raised by the undo.
   */
  it('declines to undo an edit whose job is already gone', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    vi.spyOn(harness.doubles.queues.scheduledJobs, 'upsertJobScheduler').mockImplementation(
      async () => {
        await harness.doubles.repos.scheduledJobs.delete(job.id);
        throw new Error('redis unreachable');
      },
    );

    const response = await updateJob(
      harness.container,
      writeRequest(`/api/jobs/${job.id}`, 'PATCH', { name: 'Renamed' }),
      { id: job.id },
    );

    expect(response.status).toBe(500);
    expect(await harness.doubles.repos.scheduledJobs.get(job.id)).toBeNull();
    expect(harness.doubles.logOutput()).toContain('declined to undo a scheduled-job edit');
  });

  /**
   * Disabling fails the same way round: the row must not be left saying the job is off while the
   * scheduler that would still fire it is registered.
   */
  it('rolls the row back when the scheduler cannot be removed', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    vi.spyOn(harness.doubles.queues.scheduledJobs, 'removeJobScheduler').mockRejectedValue(
      new Error('redis unreachable'),
    );

    const response = await updateJob(
      harness.container,
      writeRequest(`/api/jobs/${job.id}`, 'PATCH', { enabled: false }),
      { id: job.id },
    );

    expect(response.status).toBe(500);
    expect(await harness.doubles.repos.scheduledJobs.get(job.id)).toMatchObject({ enabled: true });
    expect(harness.doubles.queues.scheduledJobs.schedulers.has(job.id)).toBe(true);
  });

  /**
   * The same validation applies to an edit as to a create: an invalid cron never reaches the row,
   * and an unknown job is missing.
   */
  it('validates the edited schedule and reports an unknown job', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    const bad = await updateJob(
      harness.container,
      writeRequest(`/api/jobs/${job.id}`, 'PATCH', { cron: 'not a cron' }),
      { id: job.id },
    );
    expect(bad.status).toBe(400);
    const missing = await updateJob(
      harness.container,
      writeRequest('/api/jobs/nope', 'PATCH', {}),
      {
        id: 'nope',
      },
    );
    expect(missing.status).toBe(404);
  });

  /**
   * Editing the repository re-checks the host allow-list, so a job cannot be moved to a forge the
   * operator refused.
   */
  it('rejects an edit that moves the job to a disallowed repository', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    const response = await updateJob(
      harness.container,
      writeRequest(`/api/jobs/${job.id}`, 'PATCH', { repoUrl: 'https://evil.example/a/b' }),
      { id: job.id },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: REPO_URL_NOT_ALLOWED } });
  });
});

describe('deleteJob', () => {
  /**
   * Deleting removes the scheduler before the row, so a tick that fires in between cannot deliver
   * a job whose definition is already gone; the runs go with it by cascade.
   */
  it('removes the scheduler and the job with its runs', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    await harness.doubles.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'SCHEDULE',
      model: 'gpt-test',
      scheduledFor: NOW,
    });
    const response = await deleteJob(harness.container, writeRequest('/api/jobs', 'DELETE'), {
      id: job.id,
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(harness.doubles.queues.scheduledJobs.schedulers.size).toBe(0);
    expect(await harness.doubles.repos.scheduledJobs.get(job.id)).toBeNull();
    expect(await harness.doubles.repos.jobRuns.listByJob(job.id)).toEqual([]);
  });

  /**
   * The scheduler goes first, so a row that then refuses to be deleted would be left describing a
   * job with nothing to fire it — enabled in the table and invisible to BullMQ. The scheduler is
   * put back, which is the state the surviving row describes.
   */
  it('puts the scheduler back when the row cannot be deleted', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    vi.spyOn(harness.doubles.repos.scheduledJobs, 'delete').mockRejectedValue(
      new Error('database unreachable'),
    );

    const response = await deleteJob(harness.container, writeRequest('/api/jobs', 'DELETE'), {
      id: job.id,
    });

    expect(response.status).toBe(500);
    expect(harness.doubles.queues.scheduledJobs.schedulers.has(job.id)).toBe(true);
  });

  /**
   * A row another request removed in the meantime is the outcome this request asked for, so it
   * succeeds and — the half that matters — leaves the scheduler removed. Restoring it would
   * register a repeatable delivery for a job no row describes, which nothing later removes because
   * the row that named it is gone.
   */
  it('succeeds without restoring the scheduler when the row is already gone', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    vi.spyOn(harness.doubles.repos.scheduledJobs, 'delete').mockRejectedValue(
      new NotFoundError('ScheduledJob', job.id),
    );

    const response = await deleteJob(harness.container, writeRequest('/api/jobs', 'DELETE'), {
      id: job.id,
    });

    expect(response.status).toBe(204);
    expect(harness.doubles.queues.scheduledJobs.schedulers.size).toBe(0);
  });

  /**
   * A missing row reported for a different job is somebody else's failure reaching this handler,
   * not this delete succeeding, so it keeps the compensation and the failure.
   */
  it('still compensates when the missing row is not the job being deleted', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    vi.spyOn(harness.doubles.repos.scheduledJobs, 'delete').mockRejectedValue(
      new NotFoundError('ScheduledJob', 'a-different-job'),
    );

    const response = await deleteJob(harness.container, writeRequest('/api/jobs', 'DELETE'), {
      id: job.id,
    });

    expect(response.status).toBe(500);
    expect(harness.doubles.queues.scheduledJobs.schedulers.has(job.id)).toBe(true);
  });

  /**
   * An unknown job is missing rather than a silent success, so a double delete is visible.
   */
  it('reports an unknown job as missing', async () => {
    const harness = createTestContainer({ now: NOW });
    const response = await deleteJob(harness.container, writeRequest('/api/jobs', 'DELETE'), {
      id: 'nope',
    });
    expect(response.status).toBe(404);
  });
});

describe('deleteJob overlapping updateJob', () => {
  /**
   * The edit lands after the delete has taken the scheduler away and before it removes the row.
   * The edit registers a schedule the delete is about to orphan, and the delete's second removal
   * is what takes it back out; without that removal the job fires on its cron for ever with no row
   * to describe it, and nothing but a worker restart notices.
   */
  it('leaves no scheduler behind when an edit lands between the two steps of a delete', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    const edits: Response[] = [];
    const { scheduledJobs } = harness.doubles.queues;
    const removeJobScheduler = scheduledJobs.removeJobScheduler.bind(scheduledJobs);
    vi.spyOn(scheduledJobs, 'removeJobScheduler').mockImplementation(async (key: string) => {
      const removed = await removeJobScheduler(key);
      if (edits.length === 0) {
        edits.push(
          await updateJob(
            harness.container,
            writeRequest('/api/jobs', 'PATCH', { cron: '0 4 * * *' }),
            {
              id: job.id,
            },
          ),
        );
      }
      return removed;
    });

    const deleted = await deleteJob(harness.container, writeRequest('/api/jobs', 'DELETE'), {
      id: job.id,
    });

    expect(edits.map((response) => response.status)).toEqual([200]);
    expect(deleted.status).toBe(204);
    expect(await harness.doubles.repos.scheduledJobs.get(job.id)).toBeNull();
    expect([...harness.doubles.queues.scheduledJobs.schedulers.keys()]).toEqual([]);
  });

  /**
   * The other side of the same pair: the whole delete runs after the edit has written its row and
   * before the edit registers its schedule, so the edit's own upsert is the last write of all. The
   * read it does afterwards is what catches it — the row is gone, so the schedule it just
   * registered describes nothing and is taken back out, and the edit reports the job as missing
   * rather than as saved.
   */
  it('leaves no scheduler behind when a delete runs while an edit is registering one', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    const deletes: Response[] = [];
    const { repos } = harness.doubles;
    const update = repos.scheduledJobs.update.bind(repos.scheduledJobs);
    vi.spyOn(repos.scheduledJobs, 'update').mockImplementation(async (id, patch) => {
      const updated = await update(id, patch);
      if (deletes.length === 0) {
        deletes.push(
          await deleteJob(harness.container, writeRequest('/api/jobs', 'DELETE'), { id }),
        );
      }
      return updated;
    });

    const edited = await updateJob(
      harness.container,
      writeRequest('/api/jobs', 'PATCH', { cron: '0 4 * * *' }),
      { id: job.id },
    );

    expect(deletes.map((response) => response.status)).toEqual([204]);
    expect(edited.status).toBe(404);
    expect(await harness.doubles.repos.scheduledJobs.get(job.id)).toBeNull();
    expect([...harness.doubles.queues.scheduledJobs.schedulers.keys()]).toEqual([]);
  });

  /**
   * The edit's own clean-up can fail too, and it is the last thing that could have kept the two
   * stores in step. The request still reports the job as missing — that is what it is — and the
   * mismatch it could not repair is written to the log, naming the job, because there is nowhere
   * else left to record it.
   */
  it('reports a scheduler it could not take back out after a delete removed the row', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    const { repos } = harness.doubles;
    const update = repos.scheduledJobs.update.bind(repos.scheduledJobs);
    let deleted = false;
    vi.spyOn(repos.scheduledJobs, 'update').mockImplementation(async (id, patch) => {
      const updated = await update(id, patch);
      if (!deleted) {
        deleted = true;
        await deleteJob(harness.container, writeRequest('/api/jobs', 'DELETE'), { id });
        // Only now, so the delete itself still ran to completion: what fails is the edit's own
        // attempt to take back the schedule it is about to register.
        vi.spyOn(harness.doubles.queues.scheduledJobs, 'removeJobScheduler').mockRejectedValue(
          new Error('redis unreachable'),
        );
      }
      return updated;
    });

    const edited = await updateJob(
      harness.container,
      writeRequest('/api/jobs', 'PATCH', { cron: '0 4 * * *' }),
      { id: job.id },
    );

    expect(edited.status).toBe(404);
    expect(harness.doubles.logOutput()).toContain('could not undo a partial scheduled-job write');
  });
});

describe('triggerRun', () => {
  /**
   * A manual run creates the row the client immediately streams from, and passes its id on the
   * payload so the worker adopts it instead of inserting a second run.
   */
  it('creates the run row and enqueues it with the run id', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    const response = await triggerRun(harness.container, writeRequest('/api/jobs/x/run', 'POST'), {
      id: job.id,
    });
    expect(response.status).toBe(202);
    const { runId } = triggerRunResponse.parse(await response.json());
    expect(await harness.doubles.repos.jobRuns.get(runId)).toMatchObject({
      jobId: job.id,
      trigger: 'MANUAL',
      status: 'QUEUED',
    });
    const [enqueued] = harness.doubles.queues.scheduledJobs.added;
    expect(enqueued?.name).toBe(JOB_NAMES.runScheduledJob);
    expect(enqueued?.data).toEqual({ jobId: job.id, trigger: 'MANUAL', runId });
    expect(typeof enqueued?.opts?.removeOnComplete).toBe('number');
  });

  /**
   * A run cannot start without both credentials, and an unknown job cannot run at all.
   */
  it('refuses to run without credentials or for an unknown job', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    await harness.doubles.secrets.remove('GITHUB_PAT');
    const noSecrets = await triggerRun(harness.container, writeRequest('/api/jobs/x/run', 'POST'), {
      id: job.id,
    });
    expect(noSecrets.status).toBe(409);
    expect(await noSecrets.json()).toMatchObject({ error: { code: 'SECRETS_MISSING' } });

    const missing = await triggerRun(harness.container, writeRequest('/api/jobs/x/run', 'POST'), {
      id: 'nope',
    });
    expect(missing.status).toBe(404);
  });

  /**
   * A run the queue refused is closed as `FAILED` rather than left `QUEUED`, so the history shows
   * what happened instead of a run that never moves.
   */
  it('fails the run when the queue rejects the job', async () => {
    const harness = createTestContainer({ now: NOW });
    const job = await seedJob(harness);
    harness.doubles.queues.scheduledJobs.addFailure = new Error('redis unreachable');
    const response = await triggerRun(harness.container, writeRequest('/api/jobs/x/run', 'POST'), {
      id: job.id,
    });
    expect(response.status).toBe(500);
    const [run] = await harness.doubles.repos.jobRuns.listByJob(job.id);
    expect(run).toMatchObject({ status: 'FAILED', error: 'Could not enqueue the run' });
  });
});
