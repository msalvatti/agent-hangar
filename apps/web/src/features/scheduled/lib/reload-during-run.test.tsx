/**
 * Reopening a run's drawer while the run is still going.
 *
 * Layer: unit (scenario).
 * Goal: the drawer seeds the run's persisted tool calls and then opens a stream that replays the
 * run from its first event, so every call it already shows arrives again. This is the chat's
 * duplication in the sibling that shares the same reducer, and it is fixed by the same rule: each
 * call renders once. Asserted on what is rendered, because the duplication is a row the reader
 * sees.
 * Mocks: none — the persisted payload and the replayed events are written out as the API and the
 * runtime produce them.
 */
import type { AgentEvent, JobSummary, RunDetail } from '@agent-hangar/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Transcript, createInitialState, transcriptReducer } from '@/shared/transcript';
import type { TranscriptState } from '@/shared/transcript';

import { mapRunDetail } from './map-run-detail';

/** Instant the drawer is reopened, for the reducer's clock. */
const REOPENED_AT = Date.parse('2026-08-19T02:05:00.000Z');

/** The job the run belongs to, for its prompt. */
const JOB: JobSummary = {
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
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
  lastRunStatus: null,
};

/**
 * The detail of a run that is still going, with the one call it has recorded so far.
 *
 * @returns The `GET /api/runs/:id` payload.
 */
function runningRun(): RunDetail {
  return {
    run: {
      id: 'run-1',
      jobId: 'job-1',
      status: 'RUNNING',
      trigger: 'SCHEDULE',
      model: 'gpt-5.6-sol',
      usage: { inputTokens: null, outputTokens: null, stepCount: 1 },
      error: null,
      scheduledFor: '2026-08-19T02:00:00.000Z',
      queuedAt: '2026-08-19T02:00:00.000Z',
      startedAt: '2026-08-19T02:00:03.000Z',
      finishedAt: null,
    },
    output: null,
    toolCalls: [
      {
        id: 'tool-1',
        turnId: null,
        jobRunId: 'run-1',
        callId: 'call-1',
        seq: 0,
        toolName: 'run_shell',
        args: { command: 'pnpm test' },
        resultHead: 'running tests…\n',
        resultBytes: 16,
        exitCode: null,
        status: 'RUNNING',
        startedAt: '2026-08-19T02:01:00.000Z',
        finishedAt: null,
        durationMs: null,
      },
    ],
  };
}

/**
 * The events the run's stream replays when the drawer reopens, which start at the run's first
 * event because the drawer offers no resume point either.
 *
 * @returns The replayed events, oldest first.
 */
function replayedRun(): AgentEvent[] {
  return [
    { type: 'turn.started', turnId: 'run-1', at: '2026-08-19T02:00:03.000Z' },
    { type: 'step.started', step: 1 },
    {
      type: 'tool.call',
      callId: 'call-1',
      name: 'run_shell',
      args: { command: 'pnpm test' },
      seq: 1,
    },
    { type: 'tool.output.delta', callId: 'call-1', stream: 'stdout', text: 'running tests…\n' },
  ];
}

/**
 * Folds a replay into a state seeded from the persisted run, the way the reopened drawer does.
 *
 * @param detail - The persisted run.
 * @param events - The events the stream replays.
 * @returns The state the drawer renders from.
 */
function reopenThenReplay(detail: RunDetail, events: readonly AgentEvent[]): TranscriptState {
  const mapped = mapRunDetail(detail, JOB);
  let state = createInitialState({ items: mapped.items, phase: mapped.phase });
  for (const [index, event] of events.entries()) {
    state = transcriptReducer(state, {
      type: 'event',
      event,
      id: `${String(REOPENED_AT)}-${String(index)}`,
      now: REOPENED_AT,
    });
  }
  return state;
}

describe('reopening a run drawer mid-run', () => {
  /**
   * The precondition the rest depends on: the run is live, so the drawer seeds its rows and then
   * follows the stream that replays them.
   */
  it('seeds the running call and stays in a live phase', () => {
    const mapped = mapRunDetail(runningRun(), JOB);

    expect(mapped.phase).toBe('running');
    expect(mapped.items.filter((item) => item.kind === 'tool')).toHaveLength(1);
  });

  /**
   * One row for the one call the run made. A job run has no message channel, so nothing but the
   * tool calls can double here — which is why this file asserts only that.
   */
  it('renders one row per tool call after the replay', () => {
    const state = reopenThenReplay(runningRun(), replayedRun());

    render(<Transcript items={state.items} phase={state.phase} />);

    expect(document.querySelectorAll('[data-item-kind="tool"]')).toHaveLength(1);
    expect(screen.getAllByText('run_shell')).toHaveLength(1);
  });

  /**
   * The replayed output lands on the seeded row rather than beside it, so the call reads as one
   * command with one body.
   */
  it('folds the replayed output into the row the seed carried', () => {
    const state = reopenThenReplay(runningRun(), replayedRun());
    const tools = state.items.filter((item) => item.kind === 'tool');

    expect(tools[0]).toMatchObject({
      callId: 'call-1',
      status: 'running',
      startedAt: Date.parse('2026-08-19T02:01:00.000Z'),
    });
  });
});
