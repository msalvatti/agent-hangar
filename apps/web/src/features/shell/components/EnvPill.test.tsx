/**
 * Tests for `EnvPill` and the dialog it opens: the environment status in the sidebar footer.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { setScenario } from '@/mocks/scenario';
import { server } from '@/mocks/server';

import { EnvPill } from './EnvPill';

describe('EnvPill', () => {
  // Before the first report the pill says it is still checking.
  it('shows a checking state first', () => {
    render(<EnvPill />);
    expect(screen.getByRole('button', { name: 'Environment status: checking' })).toHaveTextContent(
      'checking…',
    );
  });

  // A healthy environment is stated in text as well as colour.
  it('reports a healthy environment', async () => {
    render(<EnvPill />);
    expect(
      await screen.findByRole('button', { name: 'Environment status: everything healthy' }),
    ).toHaveTextContent('docker ✓');
  });

  // A degraded environment names the failing probes in the accessible label.
  it('reports a degraded environment', async () => {
    setScenario('infra-down');
    render(<EnvPill />);
    const pill = await screen.findByRole('button', {
      name: 'Environment status: Redis, Docker failing',
    });
    expect(pill).toHaveTextContent('docker ✗');
    expect(pill.className).toContain('text-destructive');
  });

  // In the rail the text is only for assistive technology, but it is still there.
  it('keeps the status readable in icon-only mode', async () => {
    render(<EnvPill iconOnly />);
    expect(await screen.findByText('docker ✓')).toHaveClass('sr-only');
  });

  // Clicking opens the details dialog, which lists every probe with its outcome.
  it('opens a dialog listing every probe', async () => {
    setScenario('infra-down');
    render(<EnvPill />);
    await userEvent.click(await screen.findByRole('button', { name: /Environment status/ }));
    const dialog = await screen.findByRole('dialog');
    // The dialog opens on the click alone, so finding it says nothing about the report inside it:
    // until the health request lands it renders "Checking the environment…". Nor does anything
    // earlier force that request to have finished — the accessible name is matched by a pattern
    // the pre-load label ("Environment status: checking") satisfies just as well. Waiting on the
    // probe list is waiting on the thing being asserted; waiting on the dialog was waiting on a
    // round-trip's worth of nothing.
    await waitFor(() => {
      expect(dialog).toHaveTextContent('Postgres');
    });
    // One commit renders the whole list, so the rest is settled once the first probe is there.
    expect(dialog).toHaveTextContent('Workspace image');
    expect(dialog).toHaveTextContent('failing');
    // `infra:doctor`, not bare `pnpm doctor`: pnpm has a built-in `doctor` that shadows the
    // script and reports on the pnpm installation instead, exiting 0 whatever state this
    // project's environment is in. The dialog may not teach a command that cannot answer it.
    expect(dialog).toHaveTextContent('Run `pnpm infra:doctor` for details.');
    expect(dialog).not.toHaveTextContent('Run `pnpm doctor`');
  });

  /*
   * A failing probe carries the command that repairs it. The healthy ones do not: an environment
   * that works needs no instructions, and five commands beside five ticks would hide the one that
   * matters on the day something breaks.
   */
  it('shows the fix command only beside a failing probe', async () => {
    setScenario('infra-down');
    render(<EnvPill />);
    await userEvent.click(await screen.findByRole('button', { name: /Environment status/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(dialog).toHaveTextContent('Postgres');
    });
    // Redis and Docker are the two the scenario takes down.
    expect(dialog).toHaveTextContent('pnpm infra:up');
    expect(dialog).toHaveTextContent('start Docker Desktop');
    // The worker and the image are healthy in this scenario, so neither names a command.
    expect(dialog).not.toHaveTextContent('pnpm infra:image');
    expect(dialog).not.toHaveTextContent('pnpm dev');
  });

  /*
   * The worker is a probe of its own. Without it a worker that is simply not running reports as
   * `docker ✗`, and the operator is sent to repair a daemon that was answering all along.
   */
  it('names the worker rather than Docker when the worker is the one that is down', async () => {
    server.use(
      http.get('/api/health', () =>
        HttpResponse.json({
          ok: false,
          instance: 'default',
          checks: {
            db: { ok: true },
            redis: { ok: true },
            docker: { ok: false, detail: 'unknown while the worker is down' },
            image: { ok: false, detail: 'unknown while the worker is down' },
            worker: { ok: false, detail: 'worker has not reported' },
          },
        }),
      ),
    );
    render(<EnvPill />);
    const pill = await screen.findByRole('button', {
      name: 'Environment status: Worker, Docker, Workspace image failing',
    });
    expect(pill).toHaveTextContent('docker ✗');
    await userEvent.click(pill);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(dialog).toHaveTextContent('Worker');
    });
    expect(dialog).toHaveTextContent('pnpm dev');
  });

  // The dialog re-checks on demand, which is the next action after a failure.
  it('re-checks from the dialog', async () => {
    let failing = true;
    server.use(
      http.get('/api/health', () => {
        if (failing) {
          return HttpResponse.json({ error: { code: 'BOOM', message: 'nope' } }, { status: 500 });
        }
        return undefined;
      }),
    );
    render(<EnvPill />);
    await userEvent.click(screen.getByRole('button', { name: /Environment status/ }));
    expect(await screen.findByText('Checking the environment…')).toBeInTheDocument();
    failing = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Postgres')).toBeInTheDocument();
  });

  /*
   * The other button in the sidebar that never asked for a pointer cursor. Tailwind's preflight
   * gives `<button>` the default arrow, so spec 10 §10 is only met if something declares it; the
   * shared button primitive now does.
   */
  it('offers the re-check with a pointer cursor', async () => {
    render(<EnvPill />);
    await userEvent.click(screen.getByRole('button', { name: /Environment status/ }));
    expect(await screen.findByRole('button', { name: 'Retry' })).toHaveClass('cursor-pointer');
  });
});
