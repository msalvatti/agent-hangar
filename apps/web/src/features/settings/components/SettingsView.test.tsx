/**
 * Unit tests for `SettingsView`.
 *
 * Layer: unit.
 * Goal: end-to-end against MSW — both secrets start unset, saving each shows its mask (and the
 * plaintext canary never appears in the DOM), removing one returns it to unset; the environment
 * card shows the healthy summary; and both cards show an error card with Retry on failure.
 * Mocks: MSW node server serving `src/mocks/{settings,settings-status,health}.ts`.
 */
import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';

import { server } from '@/mocks/server';
import { resetStore } from '@/mocks/store';
import { registerMockServer } from '@/mocks/vitest';

import { SettingsView } from './SettingsView';

registerMockServer();

afterEach(() => {
  resetStore();
});

describe('SettingsView', () => {
  /** Both secrets start unset, saving each shows its mask, and the plaintext never leaks into the
   * DOM; removing one returns it to unset. */
  it('saves both secrets then removes one', async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const githubField = await screen.findByTestId('secret-field-GITHUB_PAT');
    const openaiField = screen.getByTestId('secret-field-OPENAI_API_KEY');
    expect(within(githubField).getByPlaceholderText('ghp_…')).toBeInTheDocument();
    expect(within(openaiField).getByPlaceholderText('sk-…')).toBeInTheDocument();

    await user.type(within(githubField).getByPlaceholderText('ghp_…'), GITHUB_CANARY);
    await user.click(within(githubField).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(within(githubField).getByTestId('secret-mask-GITHUB_PAT')).toHaveTextContent(
        `••••••••${GITHUB_CANARY.slice(-4)}`,
      );
    });
    expect(document.body.innerHTML).not.toContain(GITHUB_CANARY);

    await user.type(within(openaiField).getByPlaceholderText('sk-…'), OPENAI_CANARY);
    await user.click(within(openaiField).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(within(openaiField).getByTestId('secret-mask-OPENAI_API_KEY')).toHaveTextContent(
        `••••••••${OPENAI_CANARY.slice(-4)}`,
      );
    });
    expect(document.body.innerHTML).not.toContain(OPENAI_CANARY);

    await user.click(within(githubField).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(within(githubField).getByPlaceholderText('ghp_…')).toBeInTheDocument();
    });
  });

  /** The environment card shows the healthy summary. */
  it('shows the healthy environment summary', async () => {
    render(<SettingsView />);
    expect(await screen.findByText('Instance default')).toBeInTheDocument();
    expect(screen.getByText('Postgres')).toBeInTheDocument();
  });

  /** A settings load failure shows an error card with a working Retry. */
  it('shows an error card and retries the settings query', async () => {
    let failing = true;
    server.use(
      http.get('/api/settings', () => {
        if (failing) {
          return HttpResponse.json(
            { error: { code: 'SERVER_ERROR', message: 'boom' } },
            { status: 500 },
          );
        }
        return HttpResponse.json({
          githubPat: { set: false },
          openaiKey: { set: false },
          model: 'gpt-5-mini',
        });
      }),
    );
    const user = userEvent.setup();
    render(<SettingsView />);
    expect(await screen.findByText('Could not load credentials')).toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('secret-field-GITHUB_PAT')).toBeInTheDocument();
  });

  /** A health load failure shows an error card with a working Retry. */
  it('shows an error card and retries the health query', async () => {
    let failing = true;
    server.use(
      http.get('/api/health', () => {
        if (failing) {
          return HttpResponse.json(
            { error: { code: 'SERVER_ERROR', message: 'boom' } },
            { status: 500 },
          );
        }
        return HttpResponse.json({
          ok: true,
          instance: 'default',
          checks: {
            db: { ok: true },
            redis: { ok: true },
            docker: { ok: true },
            image: { ok: true },
          },
        });
      }),
    );
    const user = userEvent.setup();
    render(<SettingsView />);
    expect(await screen.findByText('Could not load environment')).toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Instance default')).toBeInTheDocument();
  });
});
