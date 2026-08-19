/**
 * Tests for `Composer`: submission rules, keyboard shortcuts, lock state and the model label.
 */
import type { RepoSummary } from '@agent-hangar/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ComposerProps } from './Composer';
import { Composer } from './Composer';

/** The repository the seeded mock API lists first. */
const ACME_API: RepoSummary = {
  fullName: 'acme/api',
  url: 'https://github.com/acme/api',
  defaultBranch: 'main',
  private: false,
  description: null,
};

/** Props of a `new`-mode composer, all of which the tests may override. */
type NewComposerProps = Extract<ComposerProps, { mode: 'new' }>;

/** Renders a `new`-mode composer with everything chosen unless overridden. */
function renderNew(overrides: Partial<NewComposerProps> = {}) {
  const props: NewComposerProps = {
    mode: 'new',
    repo: ACME_API,
    onRepoChange: vi.fn(),
    branch: 'main',
    onBranchChange: vi.fn(),
    value: 'Do the thing',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    model: 'gpt-5.6-sol',
    ...overrides,
  };
  return { props, ...render(<Composer {...props} />) };
}

describe('Composer', () => {
  // In `new` mode the repository still has to be chosen, so both pickers are on screen.
  it('shows the repository and branch pickers in new mode', () => {
    renderNew();
    expect(screen.getByRole('button', { name: /acme\/api/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /main/ })).toBeInTheDocument();
  });

  // A follow-up inherits the chat's repository, so the pickers would be noise.
  it('hides the pickers in followup mode', () => {
    render(
      <Composer mode="followup" value="next" onChange={vi.fn()} onSubmit={vi.fn()} model={null} />,
    );
    expect(screen.queryByRole('button', { name: /Choose repository/ })).not.toBeInTheDocument();
  });

  // The textarea is labelled for assistive technology even though the label is visually hidden.
  it('labels the textarea', () => {
    renderNew();
    expect(screen.getByLabelText('Prompt')).toBeInstanceOf(HTMLTextAreaElement);
  });

  // Send stays disabled until a repository, a branch and a non-blank prompt all exist.
  it.each([
    ['an empty prompt', { value: '   ' }],
    ['no repository', { repo: null }],
    ['no branch', { branch: null }],
  ])('disables Send with %s', (_label, overrides) => {
    renderNew(overrides);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  // With everything chosen the button is live and reports the submission.
  it('submits when Send is clicked', async () => {
    const onSubmit = vi.fn();
    renderNew({ onSubmit });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  // ⌘Enter and Ctrl+Enter both send; plain Enter must keep inserting a newline.
  it('submits on meta+Enter and ctrl+Enter but not on Enter alone', async () => {
    const onSubmit = vi.fn();
    renderNew({ onSubmit });
    const textarea = screen.getByLabelText('Prompt');
    await userEvent.type(textarea, '{Meta>}{Enter}{/Meta}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await userEvent.type(textarea, '{Control>}{Enter}{/Control}');
    expect(onSubmit).toHaveBeenCalledTimes(2);
    await userEvent.type(textarea, '{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  // A shortcut must not fire while the composer is not submittable.
  it('ignores the shortcut when submission is not allowed', async () => {
    const onSubmit = vi.fn();
    renderNew({ onSubmit, value: '' });
    await userEvent.type(screen.getByLabelText('Prompt'), '{Meta>}{Enter}{/Meta}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // While a request is in flight the whole composer locks and Send shows a spinner.
  it('locks and shows a spinner while busy', () => {
    const { container } = renderNew({ busy: true });
    expect(screen.getByLabelText('Prompt')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  // An archived chat locks the composer without any request being in flight.
  it('locks when disabled', () => {
    renderNew({ disabled: true });
    expect(screen.getByLabelText('Prompt')).toBeDisabled();
  });

  // The model id is read-only chrome: a skeleton while unknown, mono text once known, nothing
  // at all when the caller has no model to show.
  it('renders the model as skeleton, label or nothing', () => {
    const { unmount } = renderNew({ model: undefined });
    expect(screen.getByTestId('model-skeleton')).toBeInTheDocument();
    unmount();

    const second = renderNew({ model: 'gpt-5.6-sol' });
    expect(screen.getByText('gpt-5.6-sol')).toBeInTheDocument();
    second.unmount();

    renderNew({ model: null });
    expect(screen.queryByTestId('model-skeleton')).not.toBeInTheDocument();
  });

  // Typing is reported to the parent, which owns the draft.
  it('reports typing to onChange', async () => {
    const onChange = vi.fn();
    renderNew({ onChange, value: '' });
    await userEvent.type(screen.getByLabelText('Prompt'), 'a');
    expect(onChange).toHaveBeenCalledWith('a');
  });

  // Choosing a branch is reported without the parent having to own the picker.
  it('reports a branch choice', async () => {
    const onBranchChange = vi.fn();
    renderNew({ onBranchChange });
    await userEvent.click(screen.getByRole('button', { name: /main/ }));
    await userEvent.click(await screen.findByRole('option', { name: /develop/ }));
    expect(onBranchChange).toHaveBeenCalledWith('develop');
  });

  // Choosing a repository is reported the same way.
  it('reports a repository choice', async () => {
    const onRepoChange = vi.fn();
    renderNew({ onRepoChange });
    await userEvent.click(screen.getByRole('button', { name: /acme\/api/ }));
    await userEvent.click(await screen.findByRole('option', { name: /acme\/web/ }));
    expect(onRepoChange).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'acme/web' }));
  });

  // The follow-up placement gets its own placeholder unless the caller overrides it.
  it('uses the placement placeholder and honours an override', () => {
    const { unmount } = render(
      <Composer mode="followup" value="" onChange={vi.fn()} onSubmit={vi.fn()} model={null} />,
    );
    expect(screen.getByPlaceholderText('Describe the next step…')).toBeInTheDocument();
    unmount();

    renderNew({ placeholder: 'Custom' });
    expect(screen.getByPlaceholderText('Custom')).toBeInTheDocument();
  });
});
