/**
 * Unit tests for `JobHeader`.
 *
 * Layer: unit.
 * Goal: the header renders name/schedule, the toggle/run-now/edit/delete actions fire their
 * callbacks, and Run now shows a spinner while busy.
 * Mocks: none — callbacks are `vi.fn()`.
 */
import type { JobSummary } from '@agent-hangar/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { JobHeader } from './JobHeader';

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

describe('JobHeader', () => {
  /** Renders the job name and a back link. */
  it('renders the job name and back link', () => {
    render(
      <JobHeader
        job={job}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onRunNow={vi.fn()}
        busy={false}
        toggling={false}
      />,
    );
    expect(screen.getByText('Nightly tests')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to scheduled jobs' })).toHaveAttribute(
      'href',
      '/scheduled',
    );
  });

  /** Toggling the switch calls onToggle. */
  it('calls onToggle', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <JobHeader
        job={job}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={onToggle}
        onRunNow={vi.fn()}
        busy={false}
        toggling={false}
      />,
    );
    await user.click(screen.getByRole('switch', { name: 'Enable Nightly tests' }));
    expect(onToggle).toHaveBeenCalled();
    expect(onToggle.mock.calls[0]?.[0]).toBe(false);
  });

  /** Clicking Run now calls onRunNow. */
  it('calls onRunNow', async () => {
    const user = userEvent.setup();
    const onRunNow = vi.fn();
    render(
      <JobHeader
        job={job}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onRunNow={onRunNow}
        busy={false}
        toggling={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(onRunNow).toHaveBeenCalledTimes(1);
  });

  /** Run now is disabled and shows a spinner while busy. */
  it('disables Run now while busy', () => {
    render(
      <JobHeader
        job={job}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onRunNow={vi.fn()}
        busy
        toggling={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
  });

  /** Edit and Delete, from the overflow menu, call their callbacks. */
  it('calls onEdit and onDelete from the overflow menu', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <JobHeader
        job={job}
        onEdit={onEdit}
        onDelete={onDelete}
        onToggle={vi.fn()}
        onRunNow={vi.fn()}
        busy={false}
        toggling={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Job actions' }));
    await user.click(await screen.findByText('Edit'));
    expect(onEdit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Job actions' }));
    await user.click(await screen.findByText('Delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  /** A toggle already in flight disables the switch, so a second click cannot race the first. */
  it('disables the enable switch while a toggle is in flight', () => {
    render(
      <JobHeader
        job={job}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onRunNow={vi.fn()}
        busy={false}
        toggling
      />,
    );
    expect(screen.getByRole('switch', { name: 'Enable Nightly tests' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
