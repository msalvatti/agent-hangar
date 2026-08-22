/**
 * Unit tests for `RunsTable` (and, via it, `RunRow`).
 *
 * Layer: unit.
 * Goal: rows render for every run in order, trigger badges and token formatting render, a
 * terminal run's duration is static while an active run's duration ticks, and a run can be opened
 * by pointer and by keyboard alone.
 * Mocks: none — fake timers for the ticking duration.
 */
import type { RunSummary } from '@agent-hangar/core';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ClientOnly from '@/shared/lib/client-only';
import { formatTimestamp, relativeTime } from '@/shared/transcript';

import { RunsTable } from './RunsTable';

/**
 * The reader's timezone, switchable per test.
 *
 * `useLocalTimeZone` reports `null` while the markup is produced and hydrated, and a component
 * that spells an instant has to say something in that window. jsdom always resolves a zone, so
 * the only way to reach that path is to stand in for the hook — with exactly what it returns
 * there, never with something kinder.
 */
const readerZone: { value: string | null } = vi.hoisted(() => ({ value: 'UTC' }));
vi.mock('@/shared/lib/client-only', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientOnly>()),
  useLocalTimeZone: () => readerZone.value,
}));

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

  /**
   * Every run must be openable without a pointer: the row's click handler is a mouse convenience,
   * so a focusable control in a cell is what actually carries the action. Tabbing to it and
   * pressing Enter opens the run — the path a keyboard or switch-access user takes.
   */
  it('opens a run from the keyboard alone', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<RunsTable runs={[finishedRun]} onOpen={onOpen} />);
    await user.tab();
    expect(screen.getByRole('button', { name: /^Open run from / })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith('run-1');
  });

  /**
   * The control opens the run exactly once: it sits inside a row that also handles clicks, so
   * without stopping propagation a pointer user would open the drawer twice.
   */
  it('opens the run once when its control is clicked', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<RunsTable runs={[finishedRun]} onOpen={onOpen} />);
    await user.click(screen.getByRole('button', { name: /^Open run from / }));
    expect(onOpen).toHaveBeenCalledTimes(1);
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

  /**
   * The started cell spells the instant in the reader's own zone once the browser reports one,
   * rather than in the machine-readable form the API sends.
   */
  it('spells the start as a readable local time', () => {
    render(<RunsTable runs={[finishedRun]} onOpen={vi.fn()} />);
    const label = formatTimestamp(finishedRun.queuedAt, 'UTC') ?? '';
    expect(screen.getByRole('button', { name: `Open run from ${label}` })).toBeInTheDocument();
  });

  /**
   * Before the browser reports a zone there is no local time to spell, and the cell is also this
   * row's accessible name — a blank one would leave the button unnameable. It says how long ago
   * instead, which is true in every zone.
   */
  it('names the run by how long ago it started while the reader zone is unknown', () => {
    readerZone.value = null;
    try {
      render(<RunsTable runs={[finishedRun]} onOpen={vi.fn()} />);
      const label = relativeTime(finishedRun.queuedAt, Date.now());
      expect(screen.getByRole('button', { name: `Open run from ${label}` })).toBeInTheDocument();
    } finally {
      readerZone.value = 'UTC';
    }
  });
});
