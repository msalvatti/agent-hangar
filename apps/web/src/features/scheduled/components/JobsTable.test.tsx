/**
 * Unit tests for `JobsTable`.
 *
 * Layer: unit.
 * Goal: rows render for every job, row click navigates to the detail page, the enabled switch
 * does not also trigger navigation, the name link is focusable, and the caption is present
 * (screen-reader only).
 * Mocks: `next/navigation`'s `useRouter`.
 */
import type { JobSummary } from '@agent-hangar/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { JobsTable } from './JobsTable';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

const jobs: JobSummary[] = [
  {
    id: 'job-1',
    name: 'Nightly tests',
    cron: '0 2 * * *',
    timezone: 'UTC',
    prompt: 'Run tests.',
    repoUrl: 'https://github.com/acme/api',
    branch: 'main',
    enabled: true,
    lastRunAt: '2026-08-19T10:00:00.000Z',
    nextRunAt: '2026-08-20T02:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastRunStatus: 'SUCCEEDED',
  },
  {
    id: 'job-2',
    name: 'Dep audit',
    cron: '0 9 * * 1',
    timezone: 'UTC',
    prompt: 'Audit deps.',
    repoUrl: 'https://github.com/acme/web',
    branch: 'main',
    enabled: false,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastRunStatus: null,
  },
];

function renderTable() {
  return render(
    <JobsTable
      jobs={jobs}
      overrides={{}}
      pending={{}}
      onToggle={vi.fn()}
      onEdit={vi.fn()}
      onRunNow={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

describe('JobsTable', () => {
  /** A row renders for every job, by name. */
  it('renders a row per job', () => {
    renderTable();
    expect(screen.getByText('Nightly tests')).toBeInTheDocument();
    expect(screen.getByText('Dep audit')).toBeInTheDocument();
  });

  /** The caption is screen-reader only. */
  it('renders an sr-only caption', () => {
    renderTable();
    expect(screen.getByText('Scheduled jobs')).toHaveClass('sr-only');
  });

  /**
   * Clicking a non-interactive cell of a row navigates to its detail page. (The name cell is a
   * real `<a>` and navigates on its own via `href`, exercised separately below.)
   */
  it('navigates to the job detail page on row click', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByText('0 9 * * 1'));
    expect(push).toHaveBeenCalledWith('/scheduled/job-2');
  });

  /** Clicking the enabled switch does not also navigate. */
  it('does not navigate when the switch is clicked', async () => {
    const user = userEvent.setup();
    renderTable();
    push.mockClear();
    await user.click(screen.getByRole('switch', { name: 'Enable Nightly tests' }));
    expect(push).not.toHaveBeenCalled();
  });

  /** Clicking the name link stops propagation, so the row's own click handler does not also fire. */
  it('stops propagation when the name link is clicked', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole('link', { name: 'Nightly tests' }));
    expect(push).not.toHaveBeenCalled();
  });

  /** The name link is focusable and keyboard-reachable. */
  it('renders the name as a focusable link', () => {
    renderTable();
    const link = screen.getByRole('link', { name: 'Nightly tests' });
    link.focus();
    expect(link).toHaveFocus();
    expect(link).toHaveAttribute('href', '/scheduled/job-1');
  });
});
