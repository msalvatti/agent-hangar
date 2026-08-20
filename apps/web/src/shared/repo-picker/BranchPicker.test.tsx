/**
 * Tests for the branch command-palette picker: disabled without a repo, auto-selecting the
 * default branch, selecting another branch, and the error state.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { server } from '@/mocks/server';

import { BranchPicker } from './BranchPicker';

/**
 * Stands in for the screen that owns the repository and branch: it clears the branch whenever
 * another repository is chosen, exactly as the new-chat screen does, and reports every branch the
 * picker selects so a test can see which repository each selection came from.
 *
 * @param props - Callback invoked with each auto-selected or chosen branch.
 */
function RepoSwitchHarness({ onSelect }: { onSelect: (branch: string) => void }) {
  // Repository and default branch move together, because they arrive together: both callers hand
  // the picker what the repository listing said about the repository they chose.
  const [repo, setRepo] = useState({ fullName: 'acme/api', defaultBranch: 'main' });
  const [branch, setBranch] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setRepo({ fullName: 'acme/docs', defaultBranch: 'master' });
          setBranch(null);
        }}
      >
        Switch repository
      </button>
      <BranchPicker
        repo={repo.fullName}
        defaultBranch={repo.defaultBranch}
        value={branch}
        onChange={(next) => {
          setBranch(next);
          onSelect(next);
        }}
      />
    </>
  );
}

describe('BranchPicker', () => {
  // Without a repo, the trigger is disabled and carries the explanatory title.
  it('is disabled with an explanatory title when repo is null', () => {
    render(<BranchPicker repo={null} defaultBranch={null} value={null} onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /Choose branch/i });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('title', 'Choose a repository first');
  });

  // Once branches load for a repo, the default branch is auto-selected exactly once.
  it('auto-selects the default branch once branches load', async () => {
    const onChange = vi.fn();
    render(<BranchPicker repo="acme/api" defaultBranch="main" value={null} onChange={onChange} />);
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('main');
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // Once a value is already set, auto-select does not override it.
  it('does not override an already-chosen value', async () => {
    const onChange = vi.fn();
    render(
      <BranchPicker repo="acme/api" defaultBranch="main" value="develop" onChange={onChange} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onChange).not.toHaveBeenCalled();
  });

  // Choosing the same repository again clears the branch back to null, and that selection has to
  // be defaulted a second time. Remembering that this repo was already defaulted once leaves the
  // caller with no branch and no way to get one, which keeps the composer disabled.
  it('auto-selects again after the value is cleared for the same repo', async () => {
    const firstOnChange = vi.fn();
    const { rerender } = render(
      <BranchPicker repo="acme/api" defaultBranch="main" value={null} onChange={firstOnChange} />,
    );
    await waitFor(() => {
      expect(firstOnChange).toHaveBeenCalledWith('main');
    });

    const secondOnChange = vi.fn();
    rerender(
      <BranchPicker repo="acme/api" defaultBranch="main" value={null} onChange={secondOnChange} />,
    );
    await waitFor(() => {
      expect(secondOnChange).toHaveBeenCalledWith('main');
    });
  });

  // Switching repository must never leave a branch of the previous one selected. The default is
  // picked from whatever branches are loaded, so a branch list that outlived its repository would
  // be auto-selected for the new one — and once a value is set the picker stops defaulting, so the
  // wrong branch would stay, sending the task to a branch of a repository nobody chose.
  it('never selects a branch of the previous repository after switching', async () => {
    const selections: string[] = [];
    const user = userEvent.setup();
    render(
      <RepoSwitchHarness
        onSelect={(branch) => {
          selections.push(branch);
        }}
      />,
    );
    await waitFor(() => {
      expect(selections).toEqual(['main']);
    });

    await user.click(screen.getByRole('button', { name: 'Switch repository' }));
    // The recorded selection and the rendered trigger are two different moments: the harness pushes
    // to `selections` inside `onSelect`, and the label needs the state that callback sets to be
    // committed. Asserting the label after waiting on the array races that commit, so both are
    // waited on together.
    await waitFor(() => {
      expect(selections).toEqual(['main', 'master']);
      expect(screen.getByRole('button', { name: /master/i })).toBeInTheDocument();
    });
  });

  /*
   * The regression this picker was carrying. A forge returns branches in its own order — GitHub's
   * is alphabetical — so `agent/…`, published minutes earlier by a chat, sorts ahead of `main`.
   * Taking the first entry of the listing therefore pinned a schedule to a throwaway work branch
   * without ever saying so, and a schedule nobody re-reads is worse wrong than obviously unset.
   *
   * The listing here is stated rather than taken from the seeded mocks on purpose: those sort the
   * default first, which is exactly why this went unseen. What the picker gets in production is
   * this shape.
   */
  it('selects the repository default even when the listing does not start with it', async () => {
    server.use(
      http.get('/api/repos/branches', () =>
        HttpResponse.json({
          branches: [
            { name: 'agent/cmt1qscc', sha: 'aaa1bbb2ccc3', protected: false },
            { name: 'develop', sha: 'bbb2ccc3ddd4', protected: false },
            { name: 'main', sha: 'ccc3ddd4eee5', protected: true },
          ],
        }),
      ),
    );
    const onChange = vi.fn();
    render(<BranchPicker repo="acme/api" defaultBranch="main" value={null} onChange={onChange} />);
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('main');
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  /*
   * When the named default is not in the listing there is nothing honest to choose, so nothing is.
   * Falling back to a position would reproduce the very bug above on the next repository whose
   * default does not sort first. Leaving it unset keeps Send disabled — which the composer already
   * explains in words — instead of quietly scheduling work against a branch nobody picked.
   */
  it('selects nothing when the default is not among the branches', async () => {
    server.use(
      http.get('/api/repos/branches', () =>
        HttpResponse.json({
          branches: [{ name: 'agent/cmt1qscc', sha: 'aaa1bbb2ccc3', protected: false }],
        }),
      ),
    );
    const onChange = vi.fn();
    render(<BranchPicker repo="acme/api" defaultBranch="main" value={null} onChange={onChange} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onChange).not.toHaveBeenCalled();
  });

  // A caller that does not know the repository's default gets no guess either.
  it('selects nothing while the default is unknown', async () => {
    const onChange = vi.fn();
    render(<BranchPicker repo="acme/api" defaultBranch={null} value={null} onChange={onChange} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onChange).not.toHaveBeenCalled();
  });

  // Selecting another branch from the list calls onChange with it.
  it('selects another branch from the list', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BranchPicker repo="acme/api" defaultBranch="main" value="main" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /main/i }));
    const option = await screen.findByText('develop');
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith('develop');
  });

  // No branches for the repo shows the empty state text and leaves the trigger unset: there is no
  // branch named by the repository's default in an empty listing, so nothing is auto-selected.
  it('shows the empty state when the repo has no branches', async () => {
    server.use(http.get('/api/repos/branches', () => HttpResponse.json({ branches: [] })));
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BranchPicker repo="acme/api" defaultBranch="main" value={null} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Choose branch/i }));
    await waitFor(() => {
      expect(screen.getByText('No branches found.')).toBeInTheDocument();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  /**
   * A repository with no branches is a dead end nothing else on screen explains: the branch stays
   * unset, so Send never enables. "No branches found." on its own reads as a glitch, so the empty
   * state says what follows from it and what the user would have to do about it.
   *
   * The wording stays with what was observed. An empty branch listing proves there is no branch;
   * it does not prove there is no commit, because a repository whose commits are reachable only
   * through tags has both — so the message asks for a branch, not for a first commit.
   */
  it('says what follows from a repository having no branches', async () => {
    server.use(http.get('/api/repos/branches', () => HttpResponse.json({ branches: [] })));
    const user = userEvent.setup();
    render(<BranchPicker repo="acme/api" defaultBranch="main" value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose branch/i }));

    const explanation = await screen.findByText(/no branches to work from/i);
    expect(explanation.textContent).toContain('Push a branch');
    expect(explanation.textContent).not.toMatch(/commit/i);
  });

  // The loading skeleton shows while the initial fetch is still in flight.
  it('shows a loading skeleton before the list arrives', async () => {
    let resolveBranches: () => void = () => {
      throw new Error('resolveBranches called before assignment');
    };
    server.use(
      http.get('/api/repos/branches', async () => {
        await new Promise<void>((resolve) => {
          resolveBranches = resolve;
        });
        return HttpResponse.json({ branches: [] });
      }),
    );
    const user = userEvent.setup();
    render(<BranchPicker repo="acme/api" defaultBranch="main" value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose branch/i }));
    await waitFor(() => {
      expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    });
    resolveBranches();
  });

  // A server error shows an inline message, and Retry recovers once the server does.
  it('shows an error state with a working Retry button', async () => {
    server.use(
      http.get('/api/repos/branches', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    render(<BranchPicker repo="acme/api" defaultBranch="main" value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose branch/i }));
    await screen.findByText(/Failed to load branches\.|boom/);

    server.resetHandlers();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('main');
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
describe('BranchPicker containment', () => {
  // The branch trigger shares the grid row with the repository one, so it has to hold its own
  // column for the same reason: a long branch name may not push into its neighbour.
  it('declares itself shrinkable and capped to its container', () => {
    render(
      <BranchPicker
        repo="acme/api"
        defaultBranch="main"
        value="release/2026-08-a-very-long-branch-name"
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole('button', {
      name: /release\/2026-08-a-very-long-branch-name/,
    });
    expect(trigger).toHaveClass('min-w-0');
    expect(trigger).toHaveClass('max-w-full');
  });

  // Capping the button only helps if the name inside then ellipsises rather than overflowing it.
  it('truncates the name inside the cap', () => {
    render(<BranchPicker repo="acme/api" defaultBranch="main" value="main" onChange={vi.fn()} />);
    expect(screen.getByText('main')).toHaveClass('truncate');
  });
});
