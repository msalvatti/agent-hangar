/**
 * Unit tests for `DeleteJobDialog`.
 *
 * Layer: unit.
 * Goal: the dialog shows the job name, confirms via the destructive action, and disables it
 * while busy.
 * Mocks: none — callbacks are `vi.fn()`.
 */
import type { JobSummary } from '@agent-hangar/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DeleteJobDialog } from './DeleteJobDialog';

const job: JobSummary = {
  id: 'job-1',
  name: 'Nightly tests',
  cron: '0 2 * * *',
  timezone: 'UTC',
  prompt: 'Run tests.',
  repoUrl: 'https://github.com/acme/api',
  branch: 'main',
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastRunStatus: null,
};

describe('DeleteJobDialog', () => {
  /** Shows the job name and confirmation body when open. */
  it('shows the job name and body text', () => {
    render(
      <DeleteJobDialog job={job} open onOpenChange={vi.fn()} onConfirm={vi.fn()} busy={false} />,
    );
    expect(screen.getByText('Delete job Nightly tests?')).toBeInTheDocument();
    expect(screen.getByText('Future runs stop; run history is deleted.')).toBeInTheDocument();
  });

  /** Clicking Delete calls onConfirm. */
  it('calls onConfirm when Delete is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <DeleteJobDialog job={job} open onOpenChange={vi.fn()} onConfirm={onConfirm} busy={false} />,
    );
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  /** The Delete button is disabled while busy. */
  it('disables Delete while busy', () => {
    render(<DeleteJobDialog job={job} open onOpenChange={vi.fn()} onConfirm={vi.fn()} busy />);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  /** Cancel calls onOpenChange with `false` as its first argument. */
  it('calls onOpenChange(false) on Cancel', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <DeleteJobDialog
        job={job}
        open
        onOpenChange={onOpenChange}
        onConfirm={vi.fn()}
        busy={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalled();
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
  });

  /** Nothing renders when closed. */
  it('renders nothing when closed', () => {
    render(
      <DeleteJobDialog
        job={job}
        open={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.queryByText('Delete job Nightly tests?')).not.toBeInTheDocument();
  });
});
