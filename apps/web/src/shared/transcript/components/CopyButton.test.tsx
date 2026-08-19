/**
 * Tests for the copy-to-clipboard button: success path, failure toast, and accessible name.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CopyButton } from './CopyButton';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

describe('CopyButton', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Clicking copies the value and flips the icon to a confirmation that reverts afterward.
  // fireEvent.click (a plain synthetic click) rather than userEvent's pointer choreography: the
  // behaviour under test is the click handler itself, not hover/focus sequencing.
  it('copies the value and shows a confirmation that reverts', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    render(<CopyButton value="pnpm test" label="Copy command" />);
    const button = screen.getByRole('button', { name: 'Copy command' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('pnpm test');
    });
    await waitFor(() => {
      expect(button.querySelector('.text-success')).not.toBeNull();
    });
    await waitFor(
      () => {
        expect(button.querySelector('.text-success')).toBeNull();
      },
      { timeout: 3_000 },
    );
  });

  // A clipboard rejection surfaces an error toast instead of throwing.
  it('shows an error toast when the clipboard write rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    render(<CopyButton value="pnpm test" label="Copy command" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Copy failed');
    });
  });

  // The button's accessible name matches the label prop.
  it('exposes the label as the accessible name', () => {
    render(<CopyButton value="x" label="Copy output" />);
    expect(screen.getByRole('button', { name: 'Copy output' })).toBeInTheDocument();
  });
});
