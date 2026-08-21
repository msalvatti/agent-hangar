/**
 * Mock handlers and in-memory store for scheduled jobs and their runs.
 *
 * Layer: mock (handlers).
 *
 * Mirrors spec 03 §4 exactly: every success body parses with the matching core Zod schema, and
 * `POST /api/jobs/:id/run` enforces the overlap policy stated in the UI — a run requested while
 * one is still `RUNNING` is recorded as a `FAILED` run instead of started.
 */
import type {
  JobRunStatus,
  JobRunTrigger,
  JobSummary,
  RunDetail,
  RunSummary,
  ToolCallView,
} from '@agent-hangar/core';
import { agentEventSchema, jobPatchRequest, jobUpsertRequest, routes } from '@agent-hangar/core';
import { HttpResponse, http } from 'msw';

import { createSseResponse, scriptedTurnFrames } from './events';
import type { SseScriptFrame } from './events';
import { getScenario } from './scenario';
import { nextId, nowIso, store } from './store';

/** 5-field cron shape check. Mirrors the UI's own adapter without importing from `features/**`. */
const CRON_SHAPE_PATTERN = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;

/** One scheduled job as held in the mock store. */
interface MockJob {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  repoUrl: string;
  branch: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One run of a scheduled job as held in the mock store. */
interface MockRun {
  id: string;
  jobId: string;
  /** The job's prompt at the time the run started, denormalized so the events handler needs no
   * job lookup. */
  prompt: string;
  status: JobRunStatus;
  trigger: JobRunTrigger;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null; stepCount: number };
  error: string | null;
  scheduledFor: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  output: string | null;
  /** Where the run pushed, recorded when its stream reports one; `null` when it pushed nothing. */
  push: { branch: string; sha: string } | null;
  toolCalls: ToolCallView[];
}

let jobs: MockJob[] = [];
let runs: MockRun[] = [];

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function seedJobs(): MockJob[] {
  const now = nowIso();
  return [
    {
      id: 'job-nightly-tests',
      name: 'Nightly tests',
      cron: '0 2 * * *',
      timezone: 'UTC',
      prompt: 'Run the full test suite and report failures.',
      repoUrl: 'https://github.com/acme/api',
      branch: 'main',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'job-dep-audit',
      name: 'Dep audit',
      cron: '0 9 * * 1',
      timezone: 'UTC',
      prompt: 'Run a dependency audit and open an issue for any critical finding.',
      repoUrl: 'https://github.com/acme/web',
      branch: 'main',
      enabled: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'job-changelog',
      name: 'Changelog',
      cron: '*/30 * * * *',
      timezone: 'America/Sao_Paulo',
      prompt: 'Summarize merged pull requests since the last run into CHANGELOG.md.',
      repoUrl: 'https://github.com/acme/api',
      branch: 'main',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function seedToolCalls(jobRunId: string, status: 'SUCCEEDED' | 'RUNNING'): ToolCallView[] {
  return [
    {
      id: `${jobRunId}-tool-1`,
      turnId: null,
      jobRunId,
      callId: 'call-1',
      seq: 0,
      toolName: 'run_shell',
      args: { command: 'pnpm test' },
      resultHead: status === 'SUCCEEDED' ? 'All tests passed.' : null,
      resultBytes: status === 'SUCCEEDED' ? 18 : null,
      exitCode: status === 'SUCCEEDED' ? 0 : null,
      status: status === 'SUCCEEDED' ? 'SUCCEEDED' : 'RUNNING',
      startedAt: isoMinutesAgo(status === 'SUCCEEDED' ? 121 : 2),
      finishedAt: status === 'SUCCEEDED' ? isoMinutesAgo(120) : null,
      durationMs: status === 'SUCCEEDED' ? 6000 : null,
    },
  ];
}

function seedRuns(): MockRun[] {
  return [
    {
      id: 'run-nightly-success',
      jobId: 'job-nightly-tests',
      prompt: 'Run the full test suite and report failures.',
      status: 'SUCCEEDED',
      trigger: 'SCHEDULE',
      model: store.model,
      usage: { inputTokens: 4200, outputTokens: 860, stepCount: 3 },
      error: null,
      scheduledFor: isoMinutesAgo(122),
      queuedAt: isoMinutesAgo(122),
      startedAt: isoMinutesAgo(121),
      finishedAt: isoMinutesAgo(120),
      output: 'Ran the test suite; all tests passed.',
      push: { branch: 'agent/job-nightly', sha: '1a2b3c4d5e6f7788' },
      toolCalls: seedToolCalls('run-nightly-success', 'SUCCEEDED'),
    },
    {
      id: 'run-nightly-running',
      jobId: 'job-nightly-tests',
      prompt: 'Run the full test suite and report failures.',
      status: 'RUNNING',
      trigger: 'SCHEDULE',
      model: store.model,
      usage: { inputTokens: null, outputTokens: null, stepCount: 1 },
      error: null,
      scheduledFor: isoMinutesAgo(3),
      queuedAt: isoMinutesAgo(3),
      startedAt: isoMinutesAgo(2),
      finishedAt: null,
      output: null,
      push: null,
      toolCalls: seedToolCalls('run-nightly-running', 'RUNNING'),
    },
    {
      id: 'run-dep-audit-failed',
      jobId: 'job-dep-audit',
      prompt: 'Run a dependency audit and open an issue for any critical finding.',
      status: 'FAILED',
      trigger: 'SCHEDULE',
      model: store.model,
      usage: { inputTokens: 1800, outputTokens: 210, stepCount: 2 },
      error: 'npm audit found 2 critical vulnerabilities',
      scheduledFor: isoMinutesAgo(6 * 24 * 60),
      queuedAt: isoMinutesAgo(6 * 24 * 60),
      startedAt: isoMinutesAgo(6 * 24 * 60 - 1),
      finishedAt: isoMinutesAgo(6 * 24 * 60 - 2),
      output: null,
      push: null,
      toolCalls: [],
    },
    {
      id: 'run-dep-audit-overlap',
      jobId: 'job-dep-audit',
      prompt: 'Run a dependency audit and open an issue for any critical finding.',
      status: 'FAILED',
      trigger: 'MANUAL',
      model: store.model,
      usage: { inputTokens: null, outputTokens: null, stepCount: 0 },
      error: 'previous run still running',
      scheduledFor: isoMinutesAgo(4 * 24 * 60),
      queuedAt: isoMinutesAgo(4 * 24 * 60),
      startedAt: null,
      finishedAt: isoMinutesAgo(4 * 24 * 60),
      output: null,
      push: null,
      toolCalls: [],
    },
    {
      id: 'run-changelog-success',
      jobId: 'job-changelog',
      prompt: 'Summarize merged pull requests since the last run into CHANGELOG.md.',
      status: 'SUCCEEDED',
      trigger: 'SCHEDULE',
      model: store.model,
      usage: { inputTokens: 950, outputTokens: 310, stepCount: 2 },
      error: null,
      scheduledFor: isoMinutesAgo(12),
      queuedAt: isoMinutesAgo(12),
      startedAt: isoMinutesAgo(11),
      finishedAt: isoMinutesAgo(10),
      output: 'Updated CHANGELOG.md with 3 merged pull requests.',
      push: { branch: 'agent/job-changelog', sha: '9f8e7d6c5b4a3322' },
      toolCalls: [],
    },
    {
      id: 'run-changelog-manual',
      jobId: 'job-changelog',
      prompt: 'Summarize merged pull requests since the last run into CHANGELOG.md.',
      status: 'SUCCEEDED',
      trigger: 'MANUAL',
      model: store.model,
      usage: { inputTokens: 900, outputTokens: 280, stepCount: 2 },
      error: null,
      scheduledFor: isoMinutesAgo(3 * 24 * 60),
      queuedAt: isoMinutesAgo(3 * 24 * 60),
      startedAt: isoMinutesAgo(3 * 24 * 60 - 1),
      finishedAt: isoMinutesAgo(3 * 24 * 60 - 2),
      output: 'Updated CHANGELOG.md manually.',
      push: null,
      toolCalls: [],
    },
  ];
}

/** Resets the scheduled-jobs mock store to its seeded state. Call from `afterEach` in tests. */
export function resetScheduledStore(): void {
  jobs = seedJobs();
  runs = seedRuns();
}

resetScheduledStore();

function jobRuns(jobId: string): MockRun[] {
  return runs
    .filter((run) => run.jobId === jobId)
    .sort((a, b) => Date.parse(b.queuedAt) - Date.parse(a.queuedAt));
}

function toJobSummary(job: MockJob): JobSummary {
  const latest = jobRuns(job.id)[0];
  return {
    id: job.id,
    name: job.name,
    cron: job.cron,
    timezone: job.timezone,
    prompt: job.prompt,
    repoUrl: job.repoUrl,
    branch: job.branch,
    enabled: job.enabled,
    lastRunAt: latest?.queuedAt ?? null,
    nextRunAt: job.enabled ? new Date(Date.now() + 60 * 60_000).toISOString() : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastRunStatus: latest?.status ?? null,
  };
}

function toRunSummary(run: MockRun): RunSummary {
  return {
    id: run.id,
    jobId: run.jobId,
    status: run.status,
    trigger: run.trigger,
    model: run.model,
    usage: run.usage,
    error: run.error,
    scheduledFor: run.scheduledFor,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function toRunDetail(run: MockRun): RunDetail {
  return {
    run: toRunSummary(run),
    output: run.output,
    push: run.push,
    toolCalls: run.toolCalls,
  };
}

function findJob(id: string): MockJob | undefined {
  return jobs.find((job) => job.id === id);
}

function findRun(id: string): MockRun | undefined {
  return runs.find((run) => run.id === id);
}

function badRequest(code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status: 400 });
}

function notFound(message: string) {
  return HttpResponse.json({ error: { code: 'NOT_FOUND', message } }, { status: 404 });
}

function conflict(code: string, message: string) {
  return HttpResponse.json({ error: { code, message } }, { status: 409 });
}

/** Status the cancel route answers with once the request has to reach the worker. */
const CANCEL_REQUESTED_STATUS = 202;

/** How a scripted stream ended, when it ended at all. */
interface StreamOutcome {
  status: Extract<JobRunStatus, 'SUCCEEDED' | 'FAILED'>;
  finalMessage: string | null;
  error: string | null;
}

/** A run whose stream is still worth threading live — the drawer connects and offers Stop. */
function isActiveRunStatus(status: JobRunStatus): boolean {
  return status === 'RUNNING' || status === 'QUEUED' || status === 'PREPARING';
}

/**
 * Reads the outcome one scripted frame carries, if any.
 *
 * The frame's payload is `unknown`, so it is parsed with the protocol schema rather than
 * asserted: a frame that is not an agent event — the `expired` marker, for one — carries no
 * outcome.
 *
 * @param data - The frame's `data` field.
 * @returns The outcome the frame ends the turn on, or `null` for any other frame.
 */
function outcomeFromFrame(data: unknown): StreamOutcome | null {
  const parsed = agentEventSchema.safeParse(data);
  if (!parsed.success) {
    return null;
  }
  if (parsed.data.type === 'turn.completed') {
    return { status: 'SUCCEEDED', finalMessage: parsed.data.finalMessage, error: null };
  }
  if (parsed.data.type === 'turn.failed') {
    return { status: 'FAILED', finalMessage: null, error: parsed.data.error.message };
  }
  return null;
}

/**
 * Fast-forwards a still-active run to the outcome its scripted stream ends on, the same
 * simplification the chat event handler makes.
 *
 * @param run - The run whose stream was just requested.
 * @param outcome - The outcome its script ends on.
 * @returns The settled copy of the run.
 */
function settleRun(run: MockRun, outcome: StreamOutcome): MockRun {
  return {
    ...run,
    status: outcome.status,
    error: outcome.error,
    finishedAt: nowIso(),
    output: outcome.finalMessage,
  };
}

/**
 * Reads the push one scripted frame reports, if any.
 *
 * The real worker writes this onto the run's row as the frame goes by, because a run's container
 * and its event stream both outlive the fact by less than the run's record does. A store that only
 * streamed it would show the line live and lose it on reload, which is the behaviour this mock
 * exists to keep out of the doubles.
 *
 * @param data - The frame's `data` field.
 * @returns Where the run pushed, or `null` for any other frame.
 */
function pushFromFrame(data: unknown): { branch: string; sha: string } | null {
  const parsed = agentEventSchema.safeParse(data);
  if (!parsed.success || parsed.data.type !== 'git.pushed') {
    return null;
  }
  return { branch: parsed.data.branch, sha: parsed.data.sha };
}

/**
 * Settles a run to its scripted outcome at the moment the terminal frame is actually delivered,
 * not the moment its stream is requested. A cancel that lands while the script is still playing
 * back must win: this only applies the outcome if the run is still active when the frame fires,
 * so a run already moved to `CANCELLED` by `POST /api/runs/:id/cancel` stays cancelled instead
 * of being overwritten back to the script's `SUCCEEDED`/`FAILED` ending.
 *
 * @param runId - The run whose stream emitted the frame.
 * @param frame - The frame `createSseResponse` just enqueued.
 */
function settleOnTerminalFrame(runId: string, frame: SseScriptFrame): void {
  // Read once per frame, after whatever an earlier frame of the same stream already wrote: a push
  // recorded a frame ago is on this copy, so settling from it never drops it.
  const current = findRun(runId);
  if (current === undefined || !isActiveRunStatus(current.status)) {
    return;
  }
  const push = pushFromFrame(frame.data);
  if (push !== null) {
    runs = runs.map((candidate) => (candidate.id === runId ? { ...candidate, push } : candidate));
    return;
  }
  const outcome = outcomeFromFrame(frame.data);
  if (outcome === null) {
    return;
  }
  const settled = settleRun(current, outcome);
  runs = runs.map((candidate) => (candidate.id === runId ? settled : candidate));
}

/**
 * Mock handlers for `/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/run(s)` and
 * `/api/runs/:id(/events|/cancel)`.
 */
export const scheduledHandlers = [
  http.get(routes.jobs, () => {
    const sorted = [...jobs].sort((a, b) => a.name.localeCompare(b.name));
    return HttpResponse.json({ jobs: sorted.map(toJobSummary) });
  }),

  http.post(routes.jobs, async ({ request }) => {
    const parsed = jobUpsertRequest.safeParse(await request.json());
    if (!parsed.success) {
      return badRequest('VALIDATION', parsed.error.message);
    }
    if (!CRON_SHAPE_PATTERN.test(parsed.data.cron)) {
      return badRequest('INVALID_CRON', 'Cron expression must have 5 fields');
    }
    const now = nowIso();
    const job: MockJob = { id: nextId(), createdAt: now, updatedAt: now, ...parsed.data };
    jobs = [...jobs, job];
    return HttpResponse.json(toJobSummary(job), { status: 201 });
  }),

  http.patch(routes.job, async ({ request, params }) => {
    const job = findJob(String(params.id));
    if (job === undefined) {
      return notFound('Job not found');
    }
    const parsed = jobPatchRequest.safeParse(await request.json());
    if (!parsed.success) {
      return badRequest('VALIDATION', parsed.error.message);
    }
    if (parsed.data.cron !== undefined && !CRON_SHAPE_PATTERN.test(parsed.data.cron)) {
      return badRequest('INVALID_CRON', 'Cron expression must have 5 fields');
    }
    const updated: MockJob = {
      id: job.id,
      name: parsed.data.name ?? job.name,
      cron: parsed.data.cron ?? job.cron,
      timezone: parsed.data.timezone ?? job.timezone,
      prompt: parsed.data.prompt ?? job.prompt,
      repoUrl: parsed.data.repoUrl ?? job.repoUrl,
      branch: parsed.data.branch ?? job.branch,
      enabled: parsed.data.enabled ?? job.enabled,
      createdAt: job.createdAt,
      updatedAt: nowIso(),
    };
    jobs = jobs.map((candidate) => (candidate.id === job.id ? updated : candidate));
    return HttpResponse.json(toJobSummary(updated));
  }),

  http.delete(routes.job, ({ params }) => {
    const job = findJob(String(params.id));
    if (job === undefined) {
      return notFound('Job not found');
    }
    jobs = jobs.filter((candidate) => candidate.id !== job.id);
    runs = runs.filter((run) => run.jobId !== job.id);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(routes.jobRun, ({ params }) => {
    const job = findJob(String(params.id));
    if (job === undefined) {
      return notFound('Job not found');
    }
    const alreadyRunning = jobRuns(job.id).some((run) => run.status === 'RUNNING');
    const now = nowIso();
    if (alreadyRunning) {
      const skipped: MockRun = {
        id: nextId(),
        jobId: job.id,
        prompt: job.prompt,
        status: 'FAILED',
        trigger: 'MANUAL',
        model: store.model,
        usage: { inputTokens: null, outputTokens: null, stepCount: 0 },
        error: 'previous run still running',
        scheduledFor: now,
        queuedAt: now,
        startedAt: null,
        finishedAt: now,
        output: null,
        push: null,
        toolCalls: [],
      };
      runs = [...runs, skipped];
      return HttpResponse.json(
        { error: { code: 'RUN_IN_PROGRESS', message: 'previous run still running' } },
        { status: 409 },
      );
    }
    const started: MockRun = {
      id: nextId(),
      jobId: job.id,
      prompt: job.prompt,
      status: 'RUNNING',
      trigger: 'MANUAL',
      model: store.model,
      usage: { inputTokens: null, outputTokens: null, stepCount: 0 },
      error: null,
      scheduledFor: now,
      queuedAt: now,
      startedAt: now,
      finishedAt: null,
      output: null,
      push: null,
      toolCalls: [],
    };
    runs = [...runs, started];
    return HttpResponse.json({ runId: started.id }, { status: 201 });
  }),

  http.get(routes.jobRuns, ({ params }) => {
    const job = findJob(String(params.id));
    if (job === undefined) {
      return notFound('Job not found');
    }
    return HttpResponse.json({ runs: jobRuns(job.id).map(toRunSummary) });
  }),

  http.get(routes.run, ({ params }) => {
    const run = findRun(String(params.id));
    if (run === undefined) {
      return notFound('Run not found');
    }
    return HttpResponse.json(toRunDetail(run));
  }),

  http.get(routes.runEvents, ({ params, request }) => {
    const run = findRun(String(params.id));
    if (run === undefined) {
      return notFound('Run not found');
    }
    const url = new URL(request.url);
    const from = url.searchParams.get('from') ?? undefined;
    // A run that had already finished replays instantly: its frames are history, not progress.
    const wasActive = isActiveRunStatus(run.status);
    const frames = scriptedTurnFrames({
      turnId: run.id,
      scenario: getScenario(),
      baseMs: Date.parse(run.queuedAt),
    }).map((frame) => (wasActive ? frame : { ...frame, delayMs: 0 }));
    const runId = run.id;
    return createSseResponse(frames, {
      ...(from === undefined ? {} : { from }),
      // Only a still-active run needs settling as its script plays out; a replay of an
      // already-terminal run has nothing left to settle.
      ...(wasActive
        ? {
            onFrame: (frame: SseScriptFrame) => {
              settleOnTerminalFrame(runId, frame);
            },
          }
        : {}),
    });
  }),

  // `POST /api/runs/:id/cancel` — the run's own route. An id this store does not know is a 404
  // rather than a fall-through to the chat mock: the real handler resolves this parameter through
  // the run repository, so a `Turn.id` is a 404 there, and a mock that answered `ok` for one would
  // hide exactly the kind of mismatch that only a real run could otherwise reveal.
  //
  // Every run it does know answers `202`. The real API answers `200` for the one case it can
  // settle by itself — a delivery removed from the queue before any worker took it — and `202`
  // once the request has to travel to the worker holding the container. This store has no queue
  // and stands in for the worker as well, so the first case never arises here; the status it
  // sends is the one the real API would send for the same run.
  http.post(routes.runCancel, ({ params }) => {
    const run = findRun(String(params.id));
    if (run === undefined) {
      return notFound('Run not found');
    }
    if (!isActiveRunStatus(run.status)) {
      return conflict('RUN_NOT_CANCELLABLE', 'This run has already finished');
    }
    const cancelled: MockRun = { ...run, status: 'CANCELLED', finishedAt: nowIso() };
    runs = runs.map((candidate) => (candidate.id === run.id ? cancelled : candidate));
    return HttpResponse.json({ ok: true }, { status: CANCEL_REQUESTED_STATUS });
  }),
];
