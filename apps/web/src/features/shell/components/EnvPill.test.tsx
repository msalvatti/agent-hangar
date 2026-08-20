/**
 * Tests for `EnvPill` and the dialog it opens: the environment status in the sidebar footer.
 */
import { render, screen } from '@testing-library/react';
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
    expect(dialog).toHaveTextContent('Postgres');
    expect(dialog).toHaveTextContent('Workspace image');
    expect(dialog).toHaveTextContent('failing');
    expect(dialog).toHaveTextContent('Run `pnpm doctor` for details.');
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
});
