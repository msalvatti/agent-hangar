/**
 * Tests for `ChatMenu`: the header overflow menu and its delete confirmation.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ChatMenu } from './ChatMenu';

/** Renders the menu with spies for every action. */
function renderMenu(archived: boolean) {
  const handlers = {
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onCopyId: vi.fn(),
    onDelete: vi.fn(),
  };
  render(<ChatMenu archived={archived} {...handlers} />);
  return handlers;
}

describe('ChatMenu', () => {
  // An active chat can be archived; the inverse action is not offered.
  it('offers Archive for an active chat', async () => {
    const handlers = renderMenu(false);
    await userEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    expect(handlers.onArchive).toHaveBeenCalledTimes(1);
  });

  // An archived chat offers Restore instead.
  it('offers Restore for an archived chat', async () => {
    const handlers = renderMenu(true);
    await userEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Restore' }));
    expect(handlers.onRestore).toHaveBeenCalledTimes(1);
  });

  // Copying the id is available in both states.
  it('copies the chat id', async () => {
    const handlers = renderMenu(false);
    await userEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Copy chat id' }));
    expect(handlers.onCopyId).toHaveBeenCalledTimes(1);
  });

  // Delete asks first, and backing out changes nothing.
  it('asks before deleting and can be cancelled', async () => {
    const handlers = renderMenu(false);
    await userEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(await screen.findByText('Delete this chat?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });

  // Confirming is what actually deletes.
  it('deletes after confirmation', async () => {
    const handlers = renderMenu(false);
    await userEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(handlers.onDelete).toHaveBeenCalledTimes(1);
  });
});
