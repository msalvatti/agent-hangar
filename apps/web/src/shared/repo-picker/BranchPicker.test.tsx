/**
 * Tests for the branch command-palette picker: disabled without a repo, auto-selecting the
 * default branch, selecting another branch, and the error state.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { server } from '@/mocks/server';

import { BranchPicker } from './BranchPicker';

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

  // A re-render for the same repo (e.g. a new onChange identity) does not auto-select again: the
  // effect's own ref guard, not just the `value !== null` check, stops the second pass.
  it('does not auto-select a second time for the same repo', async () => {
    const firstOnChange = vi.fn();
    const { rerender } = render(
      <BranchPicker repo="acme/api" value={null} onChange={firstOnChange} />,
    );
    await waitFor(() => {
      expect(firstOnChange).toHaveBeenCalledWith('main');
    });

    const secondOnChange = vi.fn();
    rerender(<BranchPicker repo="acme/api" value={null} onChange={secondOnChange} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondOnChange).not.toHaveBeenCalled();
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
