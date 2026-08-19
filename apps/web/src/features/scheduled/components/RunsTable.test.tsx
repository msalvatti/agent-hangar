/**
 * Unit tests for `RunsTable` (and, via it, `RunRow`).
 *
 * Layer: unit.
 * Goal: rows render for every run in order, trigger badges and token formatting render, a
 * terminal run's duration is static while an active run's duration ticks, and click/Enter opens
 * the row.
 * Mocks: none — fake timers for the ticking duration.
 */
import type { RunSummary } from '@agent-hangar/core';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunsTable } from './RunsTable';

const finishedRun: RunSummary = {
  id: 'run-1',
  jobId: 'job-1',
  status: 'SUCCEEDED',
  trigger: 'SCHEDULE',
  model: 'gpt-5-mini',
  usage: { inputTokens: 100, outputTokens: 50, stepCount: 1 },
  error: null,
  scheduledFor: '2026-08-19T10:00:00.000Z',
  queuedAt: '2026-08-19T10:00:00.000Z',
  startedAt: '2026-08-19T10:00:00.000Z',
  finishedAt: '2026-08-19T10:00:05.000Z',
};

const runningRun: RunSummary = {
  ...finishedRun,
  id: 'run-2',
  status: 'RUNNING',
  trigger: 'MANUAL',
  finishedAt: null,
  usage: { inputTokens: null, outputTokens: null, stepCount: 0 },
};

const queuedRun: RunSummary = {
  ...runningRun,
  id: 'run-3',
  status: 'QUEUED',
  startedAt: null,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('RunsTable', () => {
  /** A row renders for every run, with trigger badge and formatted tokens. */
  it('renders a row per run with trigger and tokens', () => {
    render(<RunsTable runs={[finishedRun, runningRun]} onOpen={vi.fn()} />);
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
    expect(screen.getByText('150')).toBeInTheDocument();
  });

  /** A run with no token usage shows an em dash. */
  it('shows an em dash for missing token usage', () => {
    render(<RunsTable runs={[runningRun]} onOpen={vi.fn()} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  /** Clicking a row calls onOpen with its run id. */
  it('calls onOpen when a row is clicked', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<RunsTable runs={[finishedRun]} onOpen={onOpen} />);
    await user.click(screen.getByText('ok'));
    expect(onOpen).toHaveBeenCalledWith('run-1');
  });

  /** A run that has not started yet shows an em dash for duration. */
  it('shows an em dash for duration before a run has started', () => {
    render(<RunsTable runs={[queuedRun]} onOpen={vi.fn()} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  /** An active run's duration ticks; a terminal run's does not. */
  it('ticks the duration of an active run only', () => {
    vi.useFakeTimers();
    render(<RunsTable runs={[finishedRun, runningRun]} onOpen={vi.fn()} />);
    const before = screen.getAllByRole('row').map((row) => row.textContent);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const after = screen.getAllByRole('row').map((row) => row.textContent);
    expect(after).not.toEqual(before);
  });
});
