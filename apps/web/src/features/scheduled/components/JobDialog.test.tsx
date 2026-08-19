/**
 * Unit tests for `JobDialog`.
 *
 * Layer: unit.
 * Goal: create mode starts blank with Save disabled until the form is valid, submitting posts the
 * contract body and closes with `onSaved`; edit mode starts prefilled and patches; a server error
 * shows an `ErrorCard` and keeps the field values; Esc closes without saving.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`.
 */
import type { JobSummary } from '@agent-hangar/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { server } from '@/mocks/server';
import { registerMockServer } from '@/mocks/vitest';

import { JobDialog } from './JobDialog';

registerMockServer();

// `cmdk`, inside the dialog's TimezoneCombobox, measures/scrolls its list with two DOM APIs
// jsdom does not implement.
class StubResizeObserver implements ResizeObserver {
  observe(): void {
    // Intentionally inert: no test below depends on resize-driven behaviour.
  }
  unobserve(): void {
    // Intentionally inert: no test below depends on resize-driven behaviour.
  }
  disconnect(): void {
    // Intentionally inert: no test below depends on resize-driven behaviour.
  }
}
function stubScrollIntoView(): void {
  // Intentionally inert: no test below depends on scroll position.
}
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  Element.prototype.scrollIntoView = stubScrollIntoView;
});

afterEach(() => {
  resetScheduledStore();
});

const job: JobSummary = {
  id: 'job-dep-audit',
  name: 'Dep audit',
  cron: '0 9 * * 1',
  timezone: 'UTC',
  prompt: 'Run a dependency audit.',
  repoUrl: 'https://github.com/acme/web',
  branch: 'main',
  enabled: false,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastRunStatus: null,
};

async function fillCreateForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Name'), 'Weekly report');
  await user.type(screen.getByLabelText('Repository'), 'acme/api');
  await user.type(screen.getByLabelText('Branch'), 'main');
  await user.type(screen.getByLabelText('Cron'), '0 8 * * 1');
  await user.type(screen.getByLabelText('Prompt'), 'Summarize the week.');
}

describe('JobDialog create mode', () => {
  /** Starts blank with Save disabled until the form becomes valid. */
  it('starts blank with Save disabled', async () => {
    render(<JobDialog open onOpenChange={vi.fn()} />);
    expect(screen.getByText('New job')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    const user = userEvent.setup();
    await fillCreateForm(user);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });
  });

  /** Submitting a valid form posts the job and closes the dialog. */
  it('saves and closes on submit', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSaved = vi.fn();
    render(<JobDialog open onOpenChange={onOpenChange} onSaved={onSaved} />);
    await fillCreateForm(user);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: 'Weekly report' }));
    });
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
  });

  /** Esc closes the dialog without saving. */
  it('closes on Escape without saving', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<JobDialog open onOpenChange={onOpenChange} />);
    await user.keyboard('{Escape}');
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
  });

  /** Cancel closes the dialog without saving. */
  it('closes on Cancel without saving', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<JobDialog open onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  /** A server error renders an ErrorCard and keeps the entered values. */
  it('shows an ErrorCard on a server error and keeps the values', async () => {
    server.use(
      http.post('/api/jobs', () =>
        HttpResponse.json(
          { error: { code: 'SERVER_ERROR', message: 'Server exploded' } },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    render(<JobDialog open onOpenChange={vi.fn()} />);
    await fillCreateForm(user);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Server exploded')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Weekly report');
  });

  /** Toggling the Enabled switch flips its state. */
  it('toggles the Enabled switch', async () => {
    const user = userEvent.setup();
    render(<JobDialog open onOpenChange={vi.fn()} />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
  });

  /** Selecting the System group's timezone option closes the combobox. */
  it('selects the system timezone from the combobox', async () => {
    const user = userEvent.setup();
    render(<JobDialog open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Timezone' }));
    await screen.findByPlaceholderText('Search timezones…');
    const [systemOption] = screen.getAllByRole('option');
    await user.click(systemOption!);
    expect(screen.queryByPlaceholderText('Search timezones…')).not.toBeInTheDocument();
  });
});

describe('JobDialog edit mode', () => {
  /** Starts prefilled from the job. */
  it('starts prefilled', () => {
    render(<JobDialog open job={job} onOpenChange={vi.fn()} />);
    expect(screen.getByText('Edit job')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Dep audit');
    expect(screen.getByLabelText('Cron')).toHaveValue('0 9 * * 1');
  });

  /** Submitting patches the existing job. */
  it('patches the job on submit', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<JobDialog open job={job} onOpenChange={vi.fn()} onSaved={onSaved} />);
    const nameInput = screen.getByLabelText('Name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Dependency audit');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'job-dep-audit', name: 'Dependency audit' }),
      );
    });
  });
});
