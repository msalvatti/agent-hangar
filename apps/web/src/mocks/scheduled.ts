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

/** How a scripted stream ended, when it ended at all. */
interface StreamOutcome {
  status: Extract<JobRunStatus, 'SUCCEEDED' | 'FAILED'>;
  finalMessage: string | null;
  error: string | null;
}

/**
 * Reads the outcome a scripted stream ends on.
 *
 * The frames carry `unknown` payloads, so each is parsed with the protocol schema rather than
 * asserted: a frame that is not an agent event — the `expired` marker, for one — carries no
 * outcome and is skipped.
 *
 * @param frames - The turn's scripted frames.
 * @returns The terminal outcome, or `null` when the script never reaches one.
 */
function streamOutcome(frames: readonly SseScriptFrame[]): StreamOutcome | null {
  let outcome: StreamOutcome | null = null;
  for (const frame of frames) {
    const parsed = agentEventSchema.safeParse(frame.data);
    if (!parsed.success) {
      continue;
    }
    if (parsed.data.type === 'turn.completed') {
      outcome = { status: 'SUCCEEDED', finalMessage: parsed.data.finalMessage, error: null };
    } else if (parsed.data.type === 'turn.failed') {
      outcome = { status: 'FAILED', finalMessage: null, error: parsed.data.error.message };
    }
  }
  return outcome;
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

/** Mock handlers for `/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/run(s)` and `/api/runs/:id(/events)`. */
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
    const wasActive =
      run.status === 'RUNNING' || run.status === 'QUEUED' || run.status === 'PREPARING';
    const frames = scriptedTurnFrames({
      turnId: run.id,
      scenario: getScenario(),
      baseMs: Date.parse(run.queuedAt),
    }).map((frame) => (wasActive ? frame : { ...frame, delayMs: 0 }));
    const outcome = wasActive ? streamOutcome(frames) : null;
    if (outcome !== null) {
      const settled = settleRun(run, outcome);
      runs = runs.map((candidate) => (candidate.id === run.id ? settled : candidate));
    }
    return createSseResponse(frames, from === undefined ? {} : { from });
  }),

  // `POST /api/turns/:id/cancel` is a shared route: the id is a `Turn.id` or a `JobRun.id`. This
  // handler answers only the job-run case and returns nothing for anything else, which hands the
  // request to the next matching handler — the chat mock, which owns the turn case.
  http.post(routes.turnCancel, ({ params }) => {
    const run = findRun(String(params.id));
    if (run === undefined) {
      return undefined;
    }
    if (run.status === 'RUNNING' || run.status === 'PREPARING' || run.status === 'QUEUED') {
      const cancelled: MockRun = { ...run, status: 'CANCELLED', finishedAt: nowIso() };
      runs = runs.map((candidate) => (candidate.id === run.id ? cancelled : candidate));
    }
    return HttpResponse.json({ ok: true });
  }),
];
