/**
 * Tests for the repository command-palette picker: opening, listing from the mock API, filtering,
 * the recent group, selection, loading/empty/error states, disabled, aria attributes, and what a
 * row says about what the token can actually do with it.
 */
import type { RepoSummary } from '@agent-hangar/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/mocks/server';

import { repoListNote } from './readiness';
import { pushRecentRepo } from './recent';
import { RepoPicker } from './RepoPicker';

afterEach(() => {
  localStorage.clear();
});

/**
 * Builds one repository, carrying only the facts it is given.
 *
 * @param fullName - The repository's `owner/name`.
 * @param facts - Whichever of `canPush`/`archived` the forge stated; omitted means it said nothing.
 * @returns The repository, shaped exactly like the contract.
 */
function repo(fullName: string, facts: Partial<RepoSummary> = {}): RepoSummary {
  return {
    fullName,
    url: `https://github.com/${fullName}`,
    defaultBranch: 'main',
    private: false,
    description: null,
    ...facts,
  };
}

/**
 * Answers `GET /api/repos` with exactly these repositories, whatever the query.
 *
 * @param repos - The listing to serve.
 * @param truncated - Whether the listing stopped at the client's page limit.
 */
function serveRepos(repos: RepoSummary[], truncated = false): void {
  server.use(http.get('/api/repos', () => HttpResponse.json({ repos, truncated })));
}

/**
 * Finds the palette row for one repository.
 *
 * @param fullName - The repository's `owner/name`.
 * @returns The row element.
 */
function rowFor(fullName: string): HTMLElement {
  const row = [...document.querySelectorAll('[data-slot="command-item"]')].find((item) =>
    item.textContent.includes(fullName),
  );
  if (row === undefined) {
    throw new Error(`Expected a command-item row for ${fullName}`);
  }
  return row as HTMLElement;
}

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

describe('RepoPicker access', () => {
  /**
   * A repository the token can only read is offered — that is a supported way to run this product,
   * and hiding it would break it silently — but the row says so before it is chosen, instead of a
   * whole turn ending at a rejected push. The sentence is in the row, not a tooltip, so it reaches
   * a screen reader too.
   */
  it('marks a read-only repository and says what it means', async () => {
    serveRepos([repo('acme/readable', { canPush: false, archived: false })]);
    const user = userEvent.setup();
    render(<RepoPicker value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));
    await screen.findByText('acme/readable');

    const row = rowFor('acme/readable');
    expect(within(row).getByText('Read-only')).toBeInTheDocument();
    expect(row.textContent).toContain('cannot push a branch back');
  });

  /**
   * An archived repository is readable and unpushable by anybody, so it is marked for the same
   * reason as a read-only one — and named separately, because unarchiving is the fix and a wider
   * token is not.
   */
  it('marks an archived repository even when the token could push', async () => {
    serveRepos([repo('acme/legacy', { canPush: true, archived: true })]);
    const user = userEvent.setup();
    render(<RepoPicker value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));
    await screen.findByText('acme/legacy');

    const row = rowFor('acme/legacy');
    expect(within(row).getByText('Archived')).toBeInTheDocument();
    expect(within(row).queryByText('Read-only')).toBeNull();
  });

  /**
   * The badge means something only if most rows do not carry one: a repository the token may push
   * to gets none, and neither does one whose forge said nothing about permissions — the absence of
   * a claim is not a claim.
   */
  it('leaves a writable repository and an unreported one unmarked', async () => {
    serveRepos([repo('acme/writable', { canPush: true, archived: false }), repo('acme/unknown')]);
    const user = userEvent.setup();
    render(<RepoPicker value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));
    await screen.findByText('acme/writable');

    for (const name of ['acme/writable', 'acme/unknown']) {
      const row = rowFor(name);
      expect(within(row).queryByText('Read-only')).toBeNull();
      expect(within(row).queryByText('Archived')).toBeNull();
      expect(row.textContent).toBe(`${name}main`);
    }
  });

  /**
   * A read-only repository is still selectable. Disabling the row would take away the one thing it
   * is good for — having the agent read it and answer questions — which is exactly the setup this
   * product's own guidance describes.
   */
  it('still lets a read-only repository be chosen', async () => {
    serveRepos([repo('acme/readable', { canPush: false, archived: false })]);
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RepoPicker value={null} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));
    await user.click(await screen.findByText('acme/readable'));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'acme/readable' }));
  });

  /**
   * A token that reaches nothing produces a bare "no results" today, which tells somebody who is
   * certain the repository exists nothing they can act on. The empty state names the token as what
   * decides the list, and it does not claim a search found no match when nothing was searched for.
   */
  it('explains an empty list instead of reporting no match', async () => {
    serveRepos([]);
    const user = userEvent.setup();
    render(<RepoPicker value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));

    expect(await screen.findByText('No repositories to show.')).toBeInTheDocument();
    expect(screen.queryByText('No repositories match.')).toBeNull();
    expect(screen.getByText(repoListNote(false))).toBeInTheDocument();
  });

  /**
   * The same explanation follows a search that matched nothing: "no match" and "the token cannot
   * see it" look identical from the outside, so the thing that decides the list is named either
   * way.
   */
  it('explains the scope of the list when a search matches nothing', async () => {
    const user = userEvent.setup();
    render(<RepoPicker value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));
    await user.type(screen.getByLabelText('Search repositories'), 'nonexistent-repo-name');

    await waitFor(() => {
      expect(screen.getByText('No repositories match.')).toBeInTheDocument();
    });
    expect(screen.getByText(repoListNote(false))).toBeInTheDocument();
  });

  /**
   * "Where is my repository?" is asked just as often of a list with results as of an empty one, so
   * the explanation is not an empty-state consolation prize.
   */
  it('explains the scope of the list even when it has results', async () => {
    const user = userEvent.setup();
    render(<RepoPicker value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));
    await screen.findByText('acme/api');

    expect(screen.getByText(repoListNote(false))).toBeInTheDocument();
  });

  /**
   * The note claims the list is everything the token can reach, and the client only reads a fixed
   * number of pages — so above that limit the claim is false and the advice actively misdirects,
   * sending somebody to widen a token that was never the problem. A truncated listing swaps the
   * sentence for one that says the search itself is incomplete.
   */
  it('stops blaming the token when the listing was truncated', async () => {
    serveRepos([repo('acme/api')], true);
    const user = userEvent.setup();
    render(<RepoPicker value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));
    await screen.findByText('acme/api');

    expect(screen.getByText(repoListNote(true))).toBeInTheDocument();
    expect(screen.queryByText(repoListNote(false))).toBeNull();
  });

  /**
   * The case the truncation flag exists for: the search runs over what was read, so a repository
   * past the page limit is reported as no match. Without the flag the empty state would tell the
   * user to change a token setting that would not bring it back.
   */
  it('explains a truncated search that matched nothing', async () => {
    serveRepos([], true);
    const user = userEvent.setup();
    render(<RepoPicker value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose repository/i }));
    await user.type(screen.getByLabelText('Search repositories'), 'older-repo');

    await waitFor(() => {
      expect(screen.getByText('No repositories match.')).toBeInTheDocument();
    });
    expect(screen.getByText(repoListNote(true))).toBeInTheDocument();
  });
});

/*
 * Layout containment.
 *
 * jsdom lays nothing out, so what can be pinned here is the declaration, not the geometry: whether
 * the trigger still says it may shrink and may not exceed its container. The two ways an
 * `inline-flex` button escapes a container are covered by `min-w-0` (as a flex item) and
 * `max-w-full` (everywhere else, where it is sized shrink-to-fit); with either missing, a long
 * `owner/repository` renders past the edge of the cell and over whatever is beside it instead of
 * ellipsising. Confirming the pixels needs a browser, which is the end-to-end suite's job.
 */
describe('RepoPicker containment', () => {
  // A repository name is as long as its owner made it, and the trigger is dropped into containers
  // of a width it does not control: a wrapping composer row, a two-column dialog grid.
  it('declares itself shrinkable and capped to its container', () => {
    render(
      <RepoPicker
        value="a-very-long-organisation-name/an-equally-long-repository-name"
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole('button', { name: /an-equally-long-repository-name/ });
    expect(trigger).toHaveClass('min-w-0');
    expect(trigger).toHaveClass('max-w-full');
  });

  // Capping the button only helps if the name inside then ellipsises rather than overflowing it.
  it('truncates the name inside the cap', () => {
    render(<RepoPicker value="acme/api" onChange={vi.fn()} />);
    expect(screen.getByText('acme/api')).toHaveClass('truncate');
  });
});
