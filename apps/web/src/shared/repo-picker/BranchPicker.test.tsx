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
  const [repo, setRepo] = useState('acme/api');
  const [branch, setBranch] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setRepo('acme/docs');
          setBranch(null);
        }}
      >
        Switch repository
      </button>
      <BranchPicker
        repo={repo}
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
    render(<BranchPicker repo={null} value={null} onChange={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: /Choose branch/i });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute('title', 'Choose a repository first');
  });

  // Once branches load for a repo, the default branch is auto-selected exactly once.
  it('auto-selects the default branch once branches load', async () => {
    const onChange = vi.fn();
    render(<BranchPicker repo="acme/api" value={null} onChange={onChange} />);
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('main');
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // Once a value is already set, auto-select does not override it.
  it('does not override an already-chosen value', async () => {
    const onChange = vi.fn();
    render(<BranchPicker repo="acme/api" value="develop" onChange={onChange} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onChange).not.toHaveBeenCalled();
  });

  // Choosing the same repository again clears the branch back to null, and that selection has to
  // be defaulted a second time. Remembering that this repo was already defaulted once leaves the
  // caller with no branch and no way to get one, which keeps the composer disabled.
  it('auto-selects again after the value is cleared for the same repo', async () => {
    const firstOnChange = vi.fn();
    const { rerender } = render(
      <BranchPicker repo="acme/api" value={null} onChange={firstOnChange} />,
    );
    await waitFor(() => {
      expect(firstOnChange).toHaveBeenCalledWith('main');
    });

    const secondOnChange = vi.fn();
    rerender(<BranchPicker repo="acme/api" value={null} onChange={secondOnChange} />);
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
    await waitFor(() => {
      expect(selections).toEqual(['main', 'master']);
    });
    expect(screen.getByRole('button', { name: /master/i })).toBeInTheDocument();
  });

  // Selecting another branch from the list calls onChange with it.
  it('selects another branch from the list', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BranchPicker repo="acme/api" value="main" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /main/i }));
    const option = await screen.findByText('develop');
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith('develop');
  });

  // No branches for the repo shows the empty state text, and also — since the auto-select effect
  // shares the same `branches[0]` guard as the list — leaves the trigger unset (see also
  // `BranchPicker.tsx`'s effect comment on why the two share one check).
  it('shows the empty state when the repo has no branches', async () => {
    server.use(http.get('/api/repos/branches', () => HttpResponse.json({ branches: [] })));
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BranchPicker repo="acme/api" value={null} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Choose branch/i }));
    await waitFor(() => {
      expect(screen.getByText('No branches found.')).toBeInTheDocument();
    });
    expect(onChange).not.toHaveBeenCalled();
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
    render(<BranchPicker repo="acme/api" value={null} onChange={vi.fn()} />);
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
    render(<BranchPicker repo="acme/api" value={null} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Choose branch/i }));
    await screen.findByText(/Failed to load branches\.|boom/);

    server.resetHandlers();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('main');
  });
});
