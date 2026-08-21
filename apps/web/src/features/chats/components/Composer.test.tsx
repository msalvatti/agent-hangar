/**
 * Tests for `Composer`: submission rules, keyboard shortcuts, lock state and the model label.
 */
import type { RepoSummary } from '@agent-hangar/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { server } from '@/mocks/server';

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

  /*
   * The chat screen was picking the wrong branch for the same reason the job dialog was: the
   * branch picker defaulted to the first entry of the listing, and a forge orders branches its own
   * way. What the composer knows and the picker did not is the repository's own default, so it
   * hands it over. The listing is stated here rather than seeded so that the rule survives the
   * fixture: the seed is the forge's order today, and a later edit to it must not be able to
   * quietly withdraw this assertion.
   */
  it('starts the chat on the repository default, not the first branch listed', async () => {
    server.use(
      http.get('/api/repos/branches', () =>
        HttpResponse.json({
          branches: [
            { name: 'agent/cmt1qscc', sha: 'aaa1bbb2ccc3', protected: false },
            { name: 'main', sha: 'ccc3ddd4eee5', protected: true },
          ],
        }),
      ),
    );
    const onBranchChange = vi.fn();
    renderNew({ branch: null, onBranchChange });
    await waitFor(() => {
      expect(onBranchChange).toHaveBeenCalledWith('main');
    });
    expect(onBranchChange).toHaveBeenCalledTimes(1);
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

  /*
   * Enter sends. This reverses what the composer used to do — Enter inserted a newline and only
   * ⌘/Ctrl+Enter sent — because the product this implements sends on Enter, and a chat box that
   * swallows Enter is read as broken rather than as different. The newline moves to Shift+Enter,
   * pinned by the test below, so nothing is lost.
   */
  it('submits on Enter', async () => {
    const onSubmit = vi.fn();
    renderNew({ onSubmit });
    await userEvent.type(screen.getByLabelText('Prompt'), '{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  // Shift+Enter is the newline: the keystroke reaches the field instead of being swallowed, and
  // nothing is sent.
  it('inserts a newline on shift+Enter without sending', async () => {
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    renderNew({ onSubmit, onChange, value: 'Do the thing' });
    await userEvent.type(screen.getByLabelText('Prompt'), '{Shift>}{Enter}{/Shift}');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith('Do the thing\n');
  });

  // ⌘Enter and Ctrl+Enter still send. They are no longer the shortest path, but they are what the
  // interface taught, and a shortcut withdrawn without notice is its own defect.
  it('still submits on meta+Enter and ctrl+Enter', async () => {
    const onSubmit = vi.fn();
    renderNew({ onSubmit });
    const textarea = screen.getByLabelText('Prompt');
    await userEvent.type(textarea, '{Meta>}{Enter}{/Meta}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await userEvent.type(textarea, '{Control>}{Enter}{/Control}');
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  // While an input method is composing, Enter commits the candidate being chosen and means
  // nothing else. Sending there would cut every word that needs an IME to type in half.
  it('does not submit while an input method is composing', () => {
    const onSubmit = vi.fn();
    renderNew({ onSubmit });
    fireEvent.keyDown(screen.getByLabelText('Prompt'), { key: 'Enter', isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // The key that sends is announced with the field, not only drawn in the button's tooltip.
  it('announces the send key on the field', () => {
    renderNew();
    expect(screen.getByLabelText('Prompt')).toHaveAttribute('aria-keyshortcuts', 'Enter');
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

  // The Send spinner honours a reduced-motion preference like every other indicator.
  it('stops the Send spinner under reduced motion', () => {
    const { container } = renderNew({ busy: true });
    expect(container.querySelector('.animate-spin')).toHaveClass('motion-reduce:animate-none');
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

describe('Composer disabled reason', () => {
  /**
   * Each of the three things that can hold Send shut is named specifically. A single "complete the
   * form" would leave the person who has a repository and cannot get a branch exactly as stuck as
   * silence does — which is the case people actually hit, because a repository with no commits has
   * no branch for the picker to default to.
   */
  it.each([
    ['no repository', { repo: null }, /Choose a repository/],
    ['no branch', { branch: null }, /Choose a branch/],
    ['an empty prompt', { value: '   ' }, /Write a prompt/],
  ])('names what is missing when there is %s', (_label, overrides, expected) => {
    renderNew(overrides);
    expect(screen.getByRole('status')).toHaveTextContent(expected);
  });

  /**
   * The reason has to be part of the control, not merely rendered beside it: a disabled button
   * does not reliably emit the pointer events a native tooltip needs, so `title` is unreachable in
   * precisely the state that needs explaining. `aria-describedby` pointing at the live region is
   * what makes the button carry its own explanation.
   */
  it('associates the reason with the Send button', () => {
    renderNew({ branch: null });
    const status = screen.getByRole('status');
    expect(status.id).not.toBe('');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute(
      'aria-describedby',
      status.id,
    );
  });

  /**
   * The branch sentence carries the part nothing else on screen says: a repository with no branches
   * has none to pick, so the picker will never fill itself in. It says "no branches" rather than
   * "no commits" because an empty branch listing is all that was observed — a repository whose
   * commits are reachable only through tags has commits and still cannot be used here.
   */
  it('explains that a repository with no branches has none to choose', () => {
    renderNew({ branch: null });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/no branches/i);
    expect(status).not.toHaveTextContent(/commits/i);
  });

  /**
   * A follow-up inherits the chat's repository and branch, so only the prompt can hold Send shut
   * there. Telling that user to choose a repository would be wrong, and a picker-shaped message in
   * a placement that renders no pickers would be worse.
   */
  it('only ever asks a follow-up for a prompt', () => {
    render(
      <Composer mode="followup" value="" onChange={vi.fn()} onSubmit={vi.fn()} model={null} />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/Write a prompt/);
    expect(status).not.toHaveTextContent(/repositor/i);
    expect(status).not.toHaveTextContent(/branch/i);
  });

  /**
   * The live region is in the document in every state — a region added at the same moment as its
   * text is not reliably announced — so a submittable composer renders it empty rather than not at
   * all, and the button describes itself with nothing.
   */
  it('says nothing, but stays present, once the composer can send', () => {
    renderNew();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Send' })).not.toHaveAttribute('aria-describedby');
  });

  /**
   * A locked composer whose reason is already on screen stays silent — the spinner says it while
   * busy, and the caller that gives no `disabledReason` is saying the same of its own lock.
   * Repeating it here would announce a change that has not happened.
   */
  it.each([
    ['busy', { busy: true }],
    ['disabled', { disabled: true }],
  ])('stays silent while the composer is %s', (_label, overrides) => {
    renderNew({ ...overrides, value: '' });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  /**
   * A lock the screen does not otherwise explain is stated here, and it has to be: the textarea
   * carries the native `disabled` attribute, which means the browser dispatches no key events into
   * it at all. Pressing Enter into a locked composer therefore does nothing and shows nothing, and
   * that is exactly how it was reported — as a composer that had stopped sending. The sentence is
   * wired to Send the same way the missing-field hints are, so the one control still on screen
   * carries the explanation.
   */
  it('states a lock the rest of the screen does not explain', () => {
    renderNew({ disabled: true, disabledReason: 'The agent is working on this chat.' });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('The agent is working on this chat.');
    expect(screen.getByLabelText('Prompt')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute(
      'aria-describedby',
      status.id,
    );
  });

  /**
   * Busy wins over the lock's own sentence. A request of the composer's own is in flight, the
   * spinner is already saying so, and the send that is on its way is usually what puts the
   * composer into the locked state a moment later — announcing both would report two reasons for
   * one disabled field.
   */
  it('shows the spinner rather than the lock reason while busy', () => {
    renderNew({ busy: true, disabled: true, disabledReason: 'The agent is working on this chat.' });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});
