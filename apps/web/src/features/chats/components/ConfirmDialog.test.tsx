/**
 * Tests for `ConfirmDialog`: the shared confirmation used by Stop and Delete.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './ConfirmDialog';

/** Renders the dialog open, with a spy for the confirm handler. */
function renderDialog(tone: 'default' | 'destructive') {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Stop the running turn?"
      description="The agent stops where it is."
      confirmLabel="Stop"
      cancelLabel="Keep running"
      tone={tone}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onOpenChange };
}

describe('ConfirmDialog', () => {
  // The dialog states what will happen before it happens.
  it('shows the title and description', () => {
    renderDialog('default');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Stop the running turn?');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('The agent stops where it is.');
  });

  // Confirming runs the action and closes the dialog.
  it('confirms and closes', async () => {
    const { onConfirm, onOpenChange } = renderDialog('default');
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // Backing out leaves the action unrun.
  it('cancels without confirming', async () => {
    const { onConfirm } = renderDialog('default');
    await userEvent.click(screen.getByRole('button', { name: 'Keep running' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // A destructive action is styled as one.
  it('styles a destructive confirmation', () => {
    renderDialog('destructive');
    expect(screen.getByRole('button', { name: 'Stop' }).className).toContain('destructive');
  });
});
