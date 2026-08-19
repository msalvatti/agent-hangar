/**
 * Tests for `ChatTitle`: the in-place rename in the chat header.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ChatTitle } from './ChatTitle';

describe('ChatTitle', () => {
  // An archived chat is read-only, so the title is plain text with no controls.
  it('renders plain text when not editable', () => {
    render(<ChatTitle title="Fix auth" editable={false} onRename={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Fix auth' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  // Clicking the title opens the editor with the current value selected in the field.
  it('opens the editor on click', async () => {
    render(<ChatTitle title="Fix auth" editable onRename={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fix auth' }));
    expect(screen.getByLabelText<HTMLInputElement>('Chat title').value).toBe('Fix auth');
  });

  // F2 is the keyboard route into the same editor.
  it('opens the editor with F2', async () => {
    render(<ChatTitle title="Fix auth" editable onRename={vi.fn()} />);
    screen.getByRole('button', { name: 'Fix auth' }).focus();
    await userEvent.keyboard('{F2}');
    expect(screen.getByLabelText('Chat title')).toBeInTheDocument();
  });

  // Enter saves the trimmed value.
  it('saves on Enter', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    render(<ChatTitle title="Fix auth" editable onRename={onRename} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fix auth' }));
    await userEvent.clear(screen.getByLabelText('Chat title'));
    await userEvent.type(screen.getByLabelText('Chat title'), '  New title  {Enter}');
    expect(onRename).toHaveBeenCalledWith('New title');
  });

  // Escape restores the original title without saving anything.
  it('discards on Escape', async () => {
    const onRename = vi.fn();
    render(<ChatTitle title="Fix auth" editable onRename={onRename} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fix auth' }));
    await userEvent.type(screen.getByLabelText('Chat title'), 'x{Escape}');
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Fix auth' })).toBeInTheDocument();
  });

  // Clicking away saves too, rather than silently dropping the edit.
  it('saves on blur', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    render(<ChatTitle title="Fix auth" editable onRename={onRename} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fix auth' }));
    await userEvent.type(screen.getByLabelText('Chat title'), '!');
    await userEvent.tab();
    expect(onRename).toHaveBeenCalledWith('Fix auth!');
  });

  // An empty title is not a rename; the original is kept.
  it('rejects an empty title', async () => {
    const onRename = vi.fn();
    render(<ChatTitle title="Fix auth" editable onRename={onRename} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fix auth' }));
    await userEvent.clear(screen.getByLabelText('Chat title'));
    await userEvent.keyboard('{Enter}');
    expect(onRename).not.toHaveBeenCalled();
  });

  // Re-saving the same text is not a change worth a request.
  it('does not rename when the title is unchanged', async () => {
    const onRename = vi.fn();
    render(<ChatTitle title="Fix auth" editable onRename={onRename} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fix auth' }));
    await userEvent.keyboard('{Enter}');
    expect(onRename).not.toHaveBeenCalled();
  });

  // A rename in flight shows a spinner next to the title.
  it('shows a spinner while renaming', () => {
    const { container } = render(<ChatTitle title="Fix auth" editable busy onRename={vi.fn()} />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  // Typing another key while focused must not open the editor.
  it('ignores other keys', async () => {
    render(<ChatTitle title="Fix auth" editable onRename={vi.fn()} />);
    screen.getByRole('button', { name: 'Fix auth' }).focus();
    await userEvent.keyboard('{F3}');
    expect(screen.queryByLabelText('Chat title')).not.toBeInTheDocument();
  });
});
