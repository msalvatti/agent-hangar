/**
 * Unit tests for `ScheduledView`.
 *
 * Layer: unit.
 * Goal: loading skeleton, seeded rows, empty state, error + retry, "New job" callback, and the
 * delete flow end-to-end against the mock server.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`; `next/navigation`.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { server } from '@/mocks/server';
import { registerMockServer } from '@/mocks/vitest';

import { ScheduledView } from './ScheduledView';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

registerMockServer();

afterEach(() => {
  resetScheduledStore();
});

describe('ScheduledView', () => {
  /** Shows the loading skeleton before the jobs query settles. */
  it('shows a loading skeleton before jobs arrive', () => {
    render(<ScheduledView />);
    expect(screen.getByTestId('jobs-skeleton')).toBeInTheDocument();
  });

  /** Renders the seeded jobs once the query settles. */
  it('renders the seeded jobs', async () => {
    render(<ScheduledView />);
    expect(await screen.findByText('Nightly tests')).toBeInTheDocument();
    expect(screen.getByText('Dep audit')).toBeInTheDocument();
    expect(screen.getByText('Changelog')).toBeInTheDocument();
  });

  /** Shows the empty state when the store has no jobs. */
  it('shows the empty state when there are no jobs', async () => {
    server.use(http.get('/api/jobs', () => HttpResponse.json({ jobs: [] })));
    render(<ScheduledView />);
    expect(await screen.findByText('No scheduled jobs yet.')).toBeInTheDocument();
  });

  /** Shows an error card and retries the query on demand. */
  it('shows an error card and retries', async () => {
    let failing = true;
    server.use(
      http.get('/api/jobs', () => {
        if (failing) {
          return HttpResponse.json(
            { error: { code: 'SERVER_ERROR', message: 'boom' } },
            { status: 500 },
          );
        }
        return HttpResponse.json({ jobs: [] });
      }),
    );
    const user = userEvent.setup();
    render(<ScheduledView />);
    expect(await screen.findByText('Could not load scheduled jobs')).toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No scheduled jobs yet.')).toBeInTheDocument();
  });

  /** "New job" calls the onNewJob callback. */
  it('calls onNewJob from the header button', async () => {
    const user = userEvent.setup();
    const onNewJob = vi.fn();
    render(<ScheduledView onNewJob={onNewJob} />);
    await screen.findByText('Nightly tests');
    await user.click(screen.getByRole('button', { name: 'New job' }));
    expect(onNewJob).toHaveBeenCalledTimes(1);
  });

  /** Without an onNewJob prop, the header button is a harmless no-op. */
  it('does not throw when New job is clicked with no onNewJob prop', async () => {
    const user = userEvent.setup();
    render(<ScheduledView />);
    await screen.findByText('Nightly tests');
    await user.click(screen.getByRole('button', { name: 'New job' }));
  });

  /** Edit calls onEditJob with the job. */
  it('calls onEditJob from the row menu', async () => {
    const user = userEvent.setup();
    const onEditJob = vi.fn();
    render(<ScheduledView onEditJob={onEditJob} />);
    await screen.findByText('Nightly tests');
    await user.click(screen.getByRole('button', { name: 'Actions for Nightly tests' }));
    await user.click(await screen.findByText('Edit'));
    expect(onEditJob).toHaveBeenCalledTimes(1);
  });

  /** Run now, from the row menu, starts a run without throwing. */
  it('starts a run from the row menu', async () => {
    const user = userEvent.setup();
    render(<ScheduledView />);
    await screen.findByText('Dep audit');
    await user.click(screen.getByRole('button', { name: 'Actions for Dep audit' }));
    await user.click(await screen.findByText('Run now'));
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  /** Cancelling the delete dialog closes it without removing the job. */
  it('keeps the job when delete is cancelled', async () => {
    const user = userEvent.setup();
    render(<ScheduledView />);
    await screen.findByText('Changelog');
    await user.click(screen.getByRole('button', { name: 'Actions for Changelog' }));
    await user.click(await screen.findByText('Delete'));
    expect(await screen.findByText('Delete job Changelog?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByText('Delete job Changelog?')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Changelog')).toBeInTheDocument();
  });

  /** Without an onEditJob prop, the row menu's Edit item is a harmless no-op. */
  it('does not throw when Edit is clicked with no onEditJob prop', async () => {
    const user = userEvent.setup();
    render(<ScheduledView />);
    await screen.findByText('Nightly tests');
    await user.click(screen.getByRole('button', { name: 'Actions for Nightly tests' }));
    await user.click(await screen.findByText('Edit'));
  });

  /** The delete flow removes the job from the table end-to-end. */
  it('deletes a job end-to-end', async () => {
    const user = userEvent.setup();
    render(<ScheduledView />);
    await screen.findByText('Changelog');
    await user.click(screen.getByRole('button', { name: 'Actions for Changelog' }));
    await user.click(await screen.findByText('Delete'));
    expect(await screen.findByText('Delete job Changelog?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(screen.queryByText('Changelog')).not.toBeInTheDocument();
    });
  });

  /** Toggling the enabled switch flips the row's state. */
  it('toggles a job enabled', async () => {
    const user = userEvent.setup();
    render(<ScheduledView />);
    await screen.findByText('Dep audit');
    const toggle = screen.getByRole('switch', { name: 'Enable Dep audit' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
  });
});
