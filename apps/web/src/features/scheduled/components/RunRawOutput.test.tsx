/**
 * Unit tests for `RunRawOutput`.
 *
 * Layer: unit.
 * Goal: shows the placeholder when empty, renders the output when present, and copies it to the
 * clipboard.
 * Mocks: a stubbed `navigator.clipboard`.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RunRawOutput } from './RunRawOutput';

/**
 * `userEvent.setup()` installs its own `navigator.clipboard`, so the stub must be applied after
 * it runs (not in a shared `beforeEach`) or `setup()` silently overwrites it.
 */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

/** Flushes the microtask queue so a fire-and-forget promise chain (`copy`'s `.then`/`.catch`) settles. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('RunRawOutput', () => {
  /** Shows the placeholder and disables copy when there is no output. */
  it('shows the placeholder when empty', () => {
    render(<RunRawOutput output={null} />);
    expect(screen.getByText('No output yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy output' })).toBeDisabled();
  });

  /** Renders the output text when present. */
  it('renders the output', () => {
    render(<RunRawOutput output="All good." />);
    expect(screen.getByText('All good.')).toBeInTheDocument();
  });

  /** Copy writes the output to the clipboard. */
  it('copies the output', async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    render(<RunRawOutput output="All good." />);
    await user.click(screen.getByRole('button', { name: 'Copy output' }));
    expect(writeText).toHaveBeenCalledWith('All good.');
    await flushMicrotasks();
  });

  /** A clipboard failure does not throw. */
  it('does not throw when the clipboard write fails', async () => {
    const user = userEvent.setup();
    const writeText = stubClipboard();
    writeText.mockRejectedValueOnce(new Error('denied'));
    render(<RunRawOutput output="All good." />);
    await user.click(screen.getByRole('button', { name: 'Copy output' }));
    await flushMicrotasks();
  });
});
