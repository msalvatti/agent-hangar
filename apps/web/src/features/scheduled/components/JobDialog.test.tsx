/**
 * Unit tests for `JobDialog`.
 *
 * Layer: unit.
 * Goal: create mode starts blank with Save disabled until the form is valid, submitting posts the
 * contract body and closes with `onSaved`; edit mode starts prefilled and patches; a server error
 * shows an `ErrorCard` and keeps the field values; Esc closes without saving; and the two-column
 * repository/branch row bounds a name of any length.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`.
 */
import type { JobSummary } from '@agent-hangar/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { server } from '@/mocks/server';

import { JobDialog } from './JobDialog';

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

/**
 * Budget for the tests that drive a command palette or fill the whole form.
 *
 * These are the most expensive tests in the suite by an order of magnitude — a palette mounts
 * hundreds of command items, and filling the form dispatches a full event sequence per keystroke —
 * so on a loaded machine they run well past the default per-test budget while every neighbour
 * finishes in tens of milliseconds. Measured at roughly 0.5 s idle and 3 s under heavy CPU
 * contention; this leaves ample room above that while still failing a test that never settles.
 */
const PALETTE_TEST_TIMEOUT_MS = 20_000;

/**
 * Fills every field of the create form. Repository and branch are command palettes, not text
 * inputs: the repository is chosen from the list, and the branch picker then defaults itself to
 * the repository's default branch, which is the interaction a user actually performs.
 *
 * @param user - The `userEvent` session driving the form.
 * @param repo - The repository row to choose and the branch its picker settles on.
 */
async function fillCreateForm(
  user: ReturnType<typeof userEvent.setup>,
  repo: { fullName: string; defaultBranch: string } = {
    fullName: 'acme/api',
    defaultBranch: 'main',
  },
) {
  await user.type(screen.getByLabelText('Name'), 'Weekly report');
  await user.click(screen.getByRole('button', { name: /Choose repository/i }));
  await user.click(await screen.findByText(repo.fullName));
  await waitFor(() => {
    expect(screen.getByRole('group', { name: 'Branch' })).toHaveTextContent(repo.defaultBranch);
  });
  await user.type(screen.getByLabelText('Cron'), '0 8 * * 1');
  await user.type(screen.getByLabelText('Prompt'), 'Summarize the week.');
}

describe('JobDialog create mode', () => {
  /** Starts blank with Save disabled until the form becomes valid. */
  it(
    'starts blank with Save disabled',
    async () => {
      render(<JobDialog open onOpenChange={vi.fn()} />);
      expect(screen.getByText('New job')).toBeInTheDocument();
      expect(screen.getByLabelText('Name')).toHaveValue('');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

      const user = userEvent.setup();
      await fillCreateForm(user);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      });
    },
    PALETTE_TEST_TIMEOUT_MS,
  );

  /** Submitting a valid form posts the job and closes the dialog. */
  it(
    'saves and closes on submit',
    async () => {
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
    },
    PALETTE_TEST_TIMEOUT_MS,
  );

  /**
   * Rule this protects: the job records the URL the listing reported. The form kept only
   * `owner/name` and rebuilt the URL against a hard-coded github.com on save, so a job on any
   * other forge the operator allowed could not be created from the dialog at all.
   */
  it(
    'posts the URL of a repository on a self-hosted forge',
    async () => {
      const bodies: unknown[] = [];
      server.use(
        http.post('/api/jobs', async ({ request }) => {
          bodies.push(await request.clone().json());
          return undefined;
        }),
      );
      const user = userEvent.setup();
      const onSaved = vi.fn();
      render(<JobDialog open onOpenChange={vi.fn()} onSaved={onSaved} />);
      await fillCreateForm(user, { fullName: 'acme/infra', defaultBranch: 'trunk' });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      });
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(onSaved).toHaveBeenCalledTimes(1);
      });
      expect(bodies).toEqual([
        expect.objectContaining({
          repoUrl: 'https://git.acme.test/acme/infra',
          branch: 'trunk',
        }),
      ]);
    },
    PALETTE_TEST_TIMEOUT_MS,
  );

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
  it(
    'shows an ErrorCard on a server error and keeps the values',
    async () => {
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
    },
    PALETTE_TEST_TIMEOUT_MS,
  );

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
  it(
    'selects the system timezone from the combobox',
    async () => {
      const user = userEvent.setup();
      render(<JobDialog open onOpenChange={vi.fn()} />);
      await user.click(screen.getByRole('button', { name: 'Timezone' }));
      await screen.findByPlaceholderText('Search timezones…');
      const [systemOption] = screen.getAllByRole('option');
      await user.click(systemOption!);
      expect(screen.queryByPlaceholderText('Search timezones…')).not.toBeInTheDocument();
    },
    PALETTE_TEST_TIMEOUT_MS,
  );
});

describe('JobDialog edit mode', () => {
  /** Starts prefilled from the job. */
  it('starts prefilled', () => {
    render(<JobDialog open job={job} onOpenChange={vi.fn()} />);
    expect(screen.getByText('Edit job')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Dep audit');
    expect(screen.getByLabelText('Cron')).toHaveValue('0 9 * * 1');
  });

  /**
   * Rule this protects: editing an unrelated field never moves the job to another forge. The
   * form used to reduce the job to `owner/name` on load and rebuild the URL against a hard-coded
   * github.com on save, rewriting the repository of a job hosted anywhere else.
   */
  it('keeps a self-hosted repository URL when another field is edited', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.patch('/api/jobs/:id', async ({ request }) => {
        bodies.push(await request.clone().json());
        return undefined;
      }),
    );
    const selfHosted: JobSummary = { ...job, repoUrl: 'https://git.acme.test/acme/infra' };
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<JobDialog open job={selfHosted} onOpenChange={vi.fn()} onSaved={onSaved} />);
    const nameInput = screen.getByLabelText('Name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Infra audit');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(bodies).toEqual([
      expect.objectContaining({ repoUrl: 'https://git.acme.test/acme/infra' }),
    ]);
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

describe('JobDialog repository row', () => {
  /*
   * The reported case: an `owner/repository` long enough to overrun its half of the two-column
   * row, which rendered the branch control on top of the repository name instead of ellipsising
   * it. What bounds it is the trigger's own cap — measured in a browser, a `min-width` on the
   * grid cell changes nothing, because the cap is also what stops the button from claiming that
   * width in the first place. jsdom lays nothing out, so this pins the declaration; the geometry
   * belongs to the end-to-end suite.
   */
  it('bounds a long repository name to its own column', () => {
    const longRepo = 'https://github.com/a-very-long-organisation-name/an-equally-long-repository';
    render(<JobDialog open job={{ ...job, repoUrl: longRepo }} onOpenChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: /an-equally-long-repository/ })).toHaveClass(
      'max-w-full',
    );
  });
});
