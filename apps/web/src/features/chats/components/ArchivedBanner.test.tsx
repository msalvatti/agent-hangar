/**
 * Tests for `ArchivedBanner`: why the chat is read-only and how to change that.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ArchivedBanner } from './ArchivedBanner';

describe('ArchivedBanner', () => {
  // The copy is fixed by spec 10 §4.2 and is announced as a status.
  it('renders the exact copy', () => {
    render(<ArchivedBanner onRestore={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'This chat is archived. Restore it to continue in a fresh workspace.',
    );
  });

  // Restore is the one action the banner offers.
  it('restores on click', async () => {
    const onRestore = vi.fn();
    render(<ArchivedBanner onRestore={onRestore} />);
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  // While restoring the button is locked and shows progress.
  it('locks while restoring', () => {
    const { container } = render(<ArchivedBanner busy onRestore={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });
});
