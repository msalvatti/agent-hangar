/**
 * Unit tests for `mapRunDetail`.
 *
 * Layer: unit.
 * Goal: every run status maps to its transcript phase, the prompt appears only when a job is
 * given, tool calls/output/error map to their item kinds, an overlap error becomes a warning
 * notice rather than an error item, and a recorded push is rebuilt as the line the live stream
 * showed.
 * Mocks: none.
 */
import { pushedNoticeText } from '@agent-hangar/core';
import type { JobRunStatus, JobSummary, RunDetail, ToolCallView } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import { mapRunDetail } from './map-run-detail';

const job: JobSummary = {
  id: 'job-1',
  name: 'Nightly tests',
  cron: '0 2 * * *',
  timezone: 'UTC',
  prompt: 'Run the suite.',
  repoUrl: 'https://github.com/acme/api',
  branch: 'main',
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastRunStatus: null,
};

const toolCall: ToolCallView = {
  id: 'tool-1',
  turnId: null,
  jobRunId: 'run-1',
  callId: 'call-1',
  seq: 0,
  toolName: 'run_shell',
  args: { command: 'pnpm test' },
  resultHead: 'All good.',
  resultBytes: 9,
  exitCode: 0,
  status: 'SUCCEEDED',
  startedAt: '2026-08-19T10:00:00.000Z',
  finishedAt: '2026-08-19T10:00:05.000Z',
  durationMs: 5000,
};

function detail(
  overrides: Partial<RunDetail['run']> = {},
  toolCalls: ToolCallView[] = [],
  push: RunDetail['push'] = null,
): RunDetail {
  return {
    run: {
      id: 'run-1',
      jobId: 'job-1',
      status: 'SUCCEEDED',
      trigger: 'MANUAL',
      model: 'gpt-5-mini',
      usage: { inputTokens: 100, outputTokens: 50, stepCount: 1 },
      error: null,
      scheduledFor: '2026-08-19T10:00:00.000Z',
      queuedAt: '2026-08-19T10:00:00.000Z',
      startedAt: '2026-08-19T10:00:01.000Z',
      finishedAt: '2026-08-19T10:00:06.000Z',
      ...overrides,
    },
    output: null,
    push,
    toolCalls,
  };
}

describe('mapRunDetail', () => {
  /** Every contract status maps to its transcript phase. */
  it('maps every run status to its phase', () => {
    const cases: [JobRunStatus, string][] = [
      ['QUEUED', 'queued'],
      ['PREPARING', 'preparing'],
      ['RUNNING', 'running'],
      ['SUCCEEDED', 'succeeded'],
      ['FAILED', 'failed'],
      ['CANCELLED', 'cancelled'],
    ];
    for (const [status, phase] of cases) {
      expect(mapRunDetail(detail({ status })).phase).toBe(phase);
    }
  });

  /** With a job given, the prompt appears as the first item. */
  it('includes the prompt when a job is given', () => {
    const result = mapRunDetail(detail(), job);
    expect(result.items[0]).toMatchObject({ kind: 'user', text: 'Run the suite.' });
  });

  /** With no job, there is no prompt item. */
  it('omits the prompt when no job is given', () => {
    const result = mapRunDetail(detail());
    expect(result.items.some((item) => item.kind === 'user')).toBe(false);
  });

  /**
   * The push a run recorded reads exactly as the live stream showed it, so the drawer says the same
   * thing either side of a reload — and it says it long after the container and the event stream
   * are both gone, which is the whole reason the run keeps it.
   */
  it('rebuilds the push notice from the run record', () => {
    const result = mapRunDetail(
      detail({}, [], { branch: 'agent/job-2f7c11a0', sha: 'c0ffee1234567890' }),
      job,
    );

    expect(result.items).toContainEqual({
      kind: 'notice',
      id: 'git-c0ffee1234567890',
      tone: 'success',
      text: pushedNoticeText('agent/job-2f7c11a0', 'c0ffee1234567890'),
    });
  });

  /** A run that pushed nothing shows no push line rather than an empty one. */
  it('shows no push notice for a run that pushed nothing', () => {
    const result = mapRunDetail(detail({}, [toolCall]), job);

    expect(result.items.some((item) => item.kind === 'notice')).toBe(false);
  });

  /**
   * The push happened after the work and before the answer that reports it, which is where a chat
   * puts the same line; a notice after the final message would read as a second event.
   */
  it('places the push between the tool calls and the output', () => {
    const withOutput: RunDetail = {
      ...detail({}, [toolCall], { branch: 'agent/job-x', sha: 'abcdef1234567890' }),
      output: 'Pushed the fix.',
    };

    const kinds = mapRunDetail(withOutput, job).items.map((item) => item.kind);

    expect(kinds).toEqual(['user', 'tool', 'notice', 'assistant']);
  });

  /** Tool calls map to tool items in order. */
  it('maps tool calls to tool items', () => {
    const result = mapRunDetail(detail({}, [toolCall]));
    expect(result.items).toContainEqual(
      expect.objectContaining({ kind: 'tool', callId: 'call-1', status: 'succeeded' }),
    );
  });

  /**
   * The row shows the stored head and the tool's full size, and the difference between the two is
   * what makes it admit it was cut. Reporting the full size as the shown size closed that gap, so
   * a result the runtime truncated claimed to be complete.
   */
  it('reports the shown output as the size of the stored head', () => {
    const cut = mapRunDetail(
      detail({}, [{ ...toolCall, resultHead: 'All good.', resultBytes: 5_000 }]),
    );
    expect(cut.items.find((item) => item.kind === 'tool')).toMatchObject({
      shownBytes: 9,
      totalBytes: 5_000,
    });

    const whole = mapRunDetail(detail({}, [toolCall]));
    expect(whole.items.find((item) => item.kind === 'tool')).toMatchObject({
      shownBytes: 9,
      totalBytes: 9,
    });
  });

  /**
   * Nothing persists the "Turn cancelled." line the stream pushes, but the run's own status is the
   * same fact, so the reopened drawer says what the live one said.
   */
  it('rebuilds the cancellation notice from a stopped run', () => {
    const result = mapRunDetail(detail({ status: 'CANCELLED' }));
    expect(result.items).toContainEqual({
      kind: 'notice',
      id: 'run-cancelled',
      tone: 'warning',
      text: 'Turn cancelled.',
    });
  });

  /** A non-null output maps to a finalized assistant item. */
  it('maps output to an assistant item', () => {
    const result = mapRunDetail({ ...detail(), output: 'Done.' });
    expect(result.items).toContainEqual(
      expect.objectContaining({ kind: 'assistant', text: 'Done.', streaming: false }),
    );
  });

  /** A non-overlap error maps to an error item. */
  it('maps a run error to an error item', () => {
    const result = mapRunDetail(detail({ status: 'FAILED', error: 'boom' }));
    expect(result.items).toContainEqual(
      expect.objectContaining({ kind: 'error', message: 'boom' }),
    );
  });

  /** The overlap-skip error maps to a warning notice, not an error item. */
  it('maps the overlap error to a warning notice', () => {
    const result = mapRunDetail(detail({ status: 'FAILED', error: 'previous run still running' }));
    expect(result.items).toContainEqual(
      expect.objectContaining({ kind: 'notice', tone: 'warning' }),
    );
    expect(result.items.some((item) => item.kind === 'error')).toBe(false);
  });

  /** null started/finished map to null instants; set ones parse to epoch millis. */
  it('maps started/finished instants', () => {
    const running = mapRunDetail(detail({ startedAt: null, finishedAt: null }));
    expect(running.startedAt).toBeNull();
    expect(running.finishedAt).toBeNull();

    const finished = mapRunDetail(detail());
    expect(finished.startedAt).toBe(Date.parse('2026-08-19T10:00:01.000Z'));
    expect(finished.finishedAt).toBe(Date.parse('2026-08-19T10:00:06.000Z'));
  });

  /**
   * The contract types a tool call's name as a free string while the transcript renders a known
   * tool, so a name this build does not recognise falls back to `run_shell` rather than being
   * asserted into a union it does not belong to.
   */
  it('falls back to a known tool for an unrecognised tool name', () => {
    const mapped = mapRunDetail(detail({}, [{ ...toolCall, toolName: 'quantum_tunnel' }]));
    const tool = mapped.items.find((item) => item.kind === 'tool');
    expect(tool?.name).toBe('run_shell');
  });
});
