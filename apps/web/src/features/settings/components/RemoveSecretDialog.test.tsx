/**
 * Unit tests for `RemoveSecretDialog`.
 *
 * Layer: unit.
 * Goal: the dialog shows the field label and body text, confirms via the destructive action, and
 * disables it while busy.
 * Mocks: none — callbacks are `vi.fn()`.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SECRET_FIELDS } from '../lib/secrets';

import { RemoveSecretDialog } from './RemoveSecretDialog';

const field = SECRET_FIELDS[0];
if (field === undefined) {
  throw new Error('expected at least one secret field');
}

describe('RemoveSecretDialog', () => {
  /** Shows the field label and confirmation body when open. */
  it('shows the field label and body text', () => {
    render(
      <RemoveSecretDialog
        field={field}
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByText(`Remove ${field.label}?`)).toBeInTheDocument();
    expect(
      screen.getByText('Workspaces will start without it until you add a new one.'),
    ).toBeInTheDocument();
  });

  /** Clicking Remove calls onConfirm. */
  it('calls onConfirm when Remove is clicked', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <RemoveSecretDialog
        field={field}
        open
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
        busy={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  /** The Remove button is disabled while busy. */
  it('disables Remove while busy', () => {
    render(
      <RemoveSecretDialog field={field} open onOpenChange={vi.fn()} onConfirm={vi.fn()} busy />,
    );
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  /** Cancel calls onOpenChange with `false` as its first argument. */
  it('calls onOpenChange(false) on Cancel', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <RemoveSecretDialog
        field={field}
        open
        onOpenChange={onOpenChange}
        onConfirm={vi.fn()}
        busy={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalled();
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
  });

  /** Nothing renders when closed. */
  it('renders nothing when closed', () => {
    render(
      <RemoveSecretDialog
        field={field}
        open={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.queryByText(`Remove ${field.label}?`)).not.toBeInTheDocument();
  });
});
