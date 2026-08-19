/**
 * Unit tests for `mapRunDetail`.
 *
 * Layer: unit.
 * Goal: every run status maps to its transcript phase, the prompt appears only when a job is
 * given, tool calls/output/error map to their item kinds, and an overlap error becomes a warning
 * notice rather than an error item.
 * Mocks: none.
 */
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

  /** Tool calls map to tool items in order. */
  it('maps tool calls to tool items', () => {
    const result = mapRunDetail(detail({}, [toolCall]));
    expect(result.items).toContainEqual(
      expect.objectContaining({ kind: 'tool', callId: 'call-1', status: 'succeeded' }),
    );
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
});
