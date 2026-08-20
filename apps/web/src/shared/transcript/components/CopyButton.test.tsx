/**
 * Tests for the copy-to-clipboard button: success path, failure toast, and accessible name.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CopyButton } from './CopyButton';

describe('CopyButton', () => {
  // `vi.spyOn` on the real, already-resolved `toast` object rather than `vi.mock('sonner', ...)`:
  // with this project's Vite/Vitest setup, a whole-module `vi.mock` factory doesn't propagate to
  // `CopyButton.tsx`'s own `import { toast } from 'sonner'` (it keeps calling the real
  // implementation) even though the test file's own import is mocked — two different module
  // records for the same specifier. Spying mutates the shared singleton object in place instead
  // of swapping the module binding, which both importers observe.
  afterEach(() => {
    vi.restoreAllMocks();
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
    const errorToast = vi.spyOn(toast, 'error').mockImplementation(() => '');
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    render(<CopyButton value="pnpm test" label="Copy command" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));

    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith('Copy failed');
    });
  });

  // The button's accessible name matches the label prop.
  it('exposes the label as the accessible name', () => {
    render(<CopyButton value="x" label="Copy output" />);
    expect(screen.getByRole('button', { name: 'Copy output' })).toBeInTheDocument();
  });
});
