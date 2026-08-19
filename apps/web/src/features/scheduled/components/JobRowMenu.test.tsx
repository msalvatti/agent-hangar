/**
 * Unit tests for `JobRowMenu`.
 *
 * Layer: unit.
 * Goal: opening the menu shows Run now / Edit / Delete, each calling its callback with the job.
 * Mocks: none — callbacks are `vi.fn()`.
 */
import type { JobSummary } from '@agent-hangar/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { JobRowMenu } from './JobRowMenu';

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

describe('JobRowMenu', () => {
  /** The trigger has an accessible name naming the job. */
  it('has an accessible trigger name', () => {
    render(<JobRowMenu job={job} onEdit={vi.fn()} onRunNow={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Actions for Nightly tests' })).toBeInTheDocument();
  });

  /** Run now calls onRunNow with the job. */
  it('calls onRunNow', async () => {
    const user = userEvent.setup();
    const onRunNow = vi.fn();
    render(<JobRowMenu job={job} onEdit={vi.fn()} onRunNow={onRunNow} onDelete={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Actions for Nightly tests' }));
    await user.click(await screen.findByText('Run now'));
    expect(onRunNow).toHaveBeenCalledWith(job);
  });

  /** Edit calls onEdit with the job. */
  it('calls onEdit', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<JobRowMenu job={job} onEdit={onEdit} onRunNow={vi.fn()} onDelete={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Actions for Nightly tests' }));
    await user.click(await screen.findByText('Edit'));
    expect(onEdit).toHaveBeenCalledWith(job);
  });

  /** Delete calls onDelete with the job. */
  it('calls onDelete', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<JobRowMenu job={job} onEdit={vi.fn()} onRunNow={vi.fn()} onDelete={onDelete} />);
    await user.click(screen.getByRole('button', { name: 'Actions for Nightly tests' }));
    await user.click(await screen.findByText('Delete'));
    expect(onDelete).toHaveBeenCalledWith(job);
  });
});
