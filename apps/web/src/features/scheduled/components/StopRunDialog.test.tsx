/**
 * Unit tests for `StopRunDialog`.
 *
 * Layer: unit.
 * Goal: shows the confirmation copy, Stop calls onConfirm, Keep running closes without
 * confirming, and nothing renders when closed.
 * Mocks: none — callbacks are `vi.fn()`.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { StopRunDialog } from './StopRunDialog';

describe('StopRunDialog', () => {
  /** Shows the confirmation title and body when open. */
  it('shows the confirmation copy', () => {
    render(<StopRunDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText('Stop this run?')).toBeInTheDocument();
  });

  /** Stop calls onConfirm. */
  it('calls onConfirm on Stop', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<StopRunDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  /** Keep running closes without calling onConfirm. */
  it('closes without confirming on Keep running', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(<StopRunDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Keep running' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalled();
  });

  /** Renders nothing when closed. */
  it('renders nothing when closed', () => {
    render(<StopRunDialog open={false} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.queryByText('Stop this run?')).not.toBeInTheDocument();
  });
});
