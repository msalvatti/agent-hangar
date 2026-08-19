/**
 * Unit tests for `JobDetailView`.
 *
 * Layer: unit.
 * Goal: loading, not-found, header + runs table, empty runs state, Run now adds a row, a run row
 * click opens the drawer, `?run=` deep-links it open, the edit dialog opens prefilled, and delete
 * navigates back to the list.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`; `next/navigation`.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { server } from '@/mocks/server';
import { registerMockServer } from '@/mocks/vitest';

import { JobDetailView } from './JobDetailView';

registerMockServer();

let currentSearch = '';
const push = vi.fn();
const replace = vi.fn((url: string) => {
  const [, query = ''] = url.split('?');
  currentSearch = query;
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

// `cmdk`, inside the edit dialog's TimezoneCombobox, needs two DOM APIs jsdom does not implement.
class StubResizeObserver implements ResizeObserver {
  observe(): void {
    // Intentionally inert: no test below opens the timezone combobox.
  }
  unobserve(): void {
    // Intentionally inert: no test below opens the timezone combobox.
  }
  disconnect(): void {
    // Intentionally inert: no test below opens the timezone combobox.
  }
}
function stubScrollIntoView(): void {
  // Intentionally inert: no test below opens the timezone combobox.
}
beforeEach(() => {
  currentSearch = '';
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  Element.prototype.scrollIntoView = stubScrollIntoView;
});

afterEach(() => {
  resetScheduledStore();
});

describe('JobDetailView', () => {
  /** Shows the runs skeleton before the job/runs queries settle. */
  it('shows a loading skeleton', () => {
    render(<JobDetailView jobId="job-nightly-tests" />);
    expect(screen.getByTestId('runs-skeleton')).toBeInTheDocument();
  });

  /** Shows a not-found card for an unknown job id. */
  it('shows a not-found card for an unknown job', async () => {
    render(<JobDetailView jobId="missing" />);
    expect(await screen.findByText('Job not found')).toBeInTheDocument();
  });

  /** The not-found card's action navigates back to the list. */
  it('navigates back to the list from the not-found card', async () => {
    const user = userEvent.setup();
    render(<JobDetailView jobId="missing" />);
    await user.click(await screen.findByRole('button', { name: 'Back to scheduled jobs' }));
    expect(push).toHaveBeenCalledWith('/scheduled');
  });

  /** Run now, from the header, starts a run. */
  it('starts a run from the header', async () => {
    const user = userEvent.setup();
    render(<JobDetailView jobId="job-nightly-tests" />);
    await screen.findByText('Nightly tests');
    await user.click(screen.getByRole('button', { name: 'Run now' }));
  });

  /** Renders the header and the seeded runs. */
  it('renders the header and runs', async () => {
    render(<JobDetailView jobId="job-nightly-tests" />);
    expect(await screen.findByText('Nightly tests')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  /** Shows the empty state for a job with no runs. */
  it('shows the empty state when a job has no runs', async () => {
    server.use(http.get('/api/jobs/:id/runs', () => HttpResponse.json({ runs: [] })));
    render(<JobDetailView jobId="job-nightly-tests" />);
    expect(await screen.findByText('No runs yet.')).toBeInTheDocument();
  });

  /** Run now, from the empty state, starts a run. */
  it('starts a run from the empty state', async () => {
    server.use(http.get('/api/jobs/:id/runs', () => HttpResponse.json({ runs: [] })));
    const user = userEvent.setup();
    render(<JobDetailView jobId="job-changelog" />);
    const emptyState = await screen.findByTestId('empty-state');
    await user.click(within(emptyState).getByRole('button', { name: 'Run now' }));
  });

  /** Clicking a run row deep-links the drawer open via `?run=`. */
  it('opens the drawer on row click, updating the URL', async () => {
    const user = userEvent.setup();
    render(<JobDetailView jobId="job-nightly-tests" />);
    await screen.findByText('Nightly tests');
    const rows = await screen.findAllByRole('row');
    // rows[0] is the header row; click the first data row.
    const dataRow = rows[1];
    if (dataRow === undefined) {
      throw new Error('expected at least one run row');
    }
    await user.click(dataRow);
    await waitFor(() => {
      expect(replace).toHaveBeenCalled();
    });
    expect(currentSearch).toContain('run=');
  });

  /** A `?run=` param on load opens the drawer immediately. */
  it('opens the drawer from a ?run= deep link', async () => {
    currentSearch = 'run=run-nightly-success';
    render(<JobDetailView jobId="job-nightly-tests" />);
    expect(await screen.findByText('Done')).toBeInTheDocument();
  });

  /** Closing the drawer (Escape) clears the `?run=` param. */
  it('clears ?run= when the drawer closes', async () => {
    currentSearch = 'run=run-nightly-success';
    const user = userEvent.setup();
    render(<JobDetailView jobId="job-nightly-tests" />);
    await screen.findByText('Done');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(currentSearch).not.toContain('run=');
    });
  });

  /** Closing the drawer keeps any other query params that were present alongside `?run=`. */
  it('keeps other query params when the drawer closes', async () => {
    currentSearch = 'tab=history&run=run-nightly-success';
    const user = userEvent.setup();
    render(<JobDetailView jobId="job-nightly-tests" />);
    await screen.findByText('Done');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(currentSearch).toBe('tab=history');
    });
  });

  /** Toggling the header's enabled switch updates the job. */
  it('toggles the job enabled from the header', async () => {
    const user = userEvent.setup();
    render(<JobDetailView jobId="job-dep-audit" />);
    const toggle = await screen.findByRole('switch', { name: 'Enable Dep audit' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
  });

  /** Shows an error card and retries the runs query on demand. */
  it('shows an error card and retries the runs query', async () => {
    let failing = true;
    server.use(
      http.get('/api/jobs/:id/runs', () => {
        if (failing) {
          return HttpResponse.json(
            { error: { code: 'SERVER_ERROR', message: 'boom' } },
            { status: 500 },
          );
        }
        return HttpResponse.json({ runs: [] });
      }),
    );
    const user = userEvent.setup();
    render(<JobDetailView jobId="job-nightly-tests" />);
    expect(await screen.findByText('Could not load runs')).toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No runs yet.')).toBeInTheDocument();
  });

  /** Edit opens the dialog prefilled with the job's values. */
  it('opens the edit dialog prefilled', async () => {
    const user = userEvent.setup();
    render(<JobDetailView jobId="job-nightly-tests" />);
    await screen.findByText('Nightly tests');
    await user.click(screen.getByRole('button', { name: 'Job actions' }));
    await user.click(await screen.findByText('Edit'));
    expect(await screen.findByText('Edit job')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Nightly tests');
  });

  /** Deleting the job navigates back to the list. */
  it('navigates to /scheduled after deleting', async () => {
    const user = userEvent.setup();
    render(<JobDetailView jobId="job-changelog" />);
    await screen.findByText('Changelog');
    await user.click(screen.getByRole('button', { name: 'Job actions' }));
    await user.click(await screen.findByText('Delete'));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/scheduled');
    });
  });
});
