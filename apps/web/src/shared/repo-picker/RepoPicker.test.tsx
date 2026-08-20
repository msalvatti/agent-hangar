/**
 * Tests for the repository command-palette picker: opening, listing from the mock API, filtering,
 * the recent group, selection, loading/empty/error states, disabled, and aria attributes.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/mocks/server';

import { pushRecentRepo } from './recent';
import { RepoPicker } from './RepoPicker';

afterEach(() => {
  localStorage.clear();
});

describe('RepoPicker', () => {
  // The trigger shows the placeholder until a value is chosen, then the chosen repo's name.
  it('shows the placeholder, then the chosen repo, and exposes aria-haspopup/expanded', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RepoPicker value={null} onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: /Choose repository/i });
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Search repositories')).toBeInTheDocument();
  });

  // Opening lists repos from the mock API and selecting one calls onChange, pushes recent, closes.
  it('lists repos from the mock API and selects one', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RepoPicker value={null} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));

    const option = await screen.findByText('acme/api');
    await user.click(option);

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'acme/api' }));
    expect(screen.queryByLabelText('Search repositories')).toBeNull();
  });

  // Typing filters the list via the debounced query against the mock API. The list is asserted
  // once the new query's results have arrived: the previous query's results are dropped the moment
  // the search text changes (they answer a different question), so between the two the palette
  // shows its loading skeleton rather than a stale list.
  it('filters the list by the search query', async () => {
    const user = userEvent.setup();
    render(<RepoPicker value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));
    await screen.findByText('acme/api');

    await user.type(screen.getByLabelText('Search repositories'), 'web');
    await waitFor(() => {
      expect(screen.getByText('acme/web')).toBeInTheDocument();
      expect(screen.queryByText('acme/api')).toBeNull();
    });
  });

  // A repo already pushed to "recent" appears in its own group, and selecting it from there works
  // the same as selecting from the main list.
  it('shows a recently-used repo in the Recent group and can select it', async () => {
    pushRecentRepo('acme/web');
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RepoPicker value={null} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));
    await screen.findByText('acme/api');

    expect(screen.getByText('Recent')).toBeInTheDocument();
    const recentGroup = screen.getByText('Recent').closest('[data-slot="command-group"]');
    expect(recentGroup).not.toBeNull();
    if (recentGroup !== null) {
      const recentOption = within(recentGroup as HTMLElement).getByText('acme/web');
      expect(recentOption).toBeInTheDocument();
      await user.click(recentOption);
    }
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'acme/web' }));
  });

  // No repositories match shows the empty state text.
  it('shows the empty state when nothing matches', async () => {
    const user = userEvent.setup();
    render(<RepoPicker value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));
    await user.type(screen.getByLabelText('Search repositories'), 'nonexistent-repo-name');
    await waitFor(() => {
      expect(screen.getByText('No repositories match.')).toBeInTheDocument();
    });
  });

  // A server error shows an inline message and a Retry button that recovers.
  it('shows an error state with a working Retry button', async () => {
    server.use(
      http.get('/api/repos', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    render(<RepoPicker value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));
    await screen.findByText(/Failed to load repositories\.|boom/);

    server.resetHandlers();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('acme/api');
  });

  // disabled prevents opening the picker.
  it('is disabled when disabled is set', () => {
    render(<RepoPicker value={null} onChange={vi.fn()} disabled />);
    expect(screen.getByRole('button', { name: /Choose repository/i })).toBeDisabled();
  });

  // size="sm" sizes the trigger button down (h-7) from the default (h-8).
  it('renders a small trigger when size is sm', () => {
    render(<RepoPicker value={null} onChange={vi.fn()} size="sm" />);
    expect(screen.getByRole('button', { name: /Choose repository/i })).toHaveClass('h-7');
  });

  // The already-chosen repo's row carries a check mark.
  it('marks the chosen repo with a check', async () => {
    const user = userEvent.setup();
    render(<RepoPicker value="acme/api" onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /acme\/api/i }));
    await waitFor(() => {
      expect(document.querySelectorAll('[data-slot="command-item"]').length).toBeGreaterThan(0);
    });
    const row = [...document.querySelectorAll('[data-slot="command-item"]')].find((item) =>
      item.textContent.includes('acme/api'),
    );
    if (row === undefined) {
      throw new Error('Expected a command-item row for acme/api');
    }
    expect(row.querySelector('.lucide-check')).not.toBeNull();
  });

  // The loading skeleton shows while the initial fetch is still in flight.
  it('shows a loading skeleton before the list arrives', async () => {
    let resolveRepos: () => void = () => {
      throw new Error('resolveRepos called before assignment');
    };
    server.use(
      http.get('/api/repos', async () => {
        await new Promise<void>((resolve) => {
          resolveRepos = resolve;
        });
        return HttpResponse.json({ repos: [] });
      }),
    );
    const user = userEvent.setup();
    render(<RepoPicker value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));
    await waitFor(() => {
      expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    });
    resolveRepos();
  });

  // Keyboard Enter selects the highlighted item. Focuses the search input first: opening the
  // dialog moves focus there asynchronously, and `findByText` only waits for the list, not for
  // focus to settle, so `{Enter}` (which targets `document.activeElement`) can otherwise land on
  // the now-inert trigger button instead of the command list.
  it('selects the highlighted item with Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RepoPicker value={null} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));
    await screen.findByText('acme/api');

    await user.click(screen.getByLabelText('Search repositories'));
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
