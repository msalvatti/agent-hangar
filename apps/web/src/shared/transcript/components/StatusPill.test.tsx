/**
 * Tests for the turn-status pill: every phase's text/icon, elapsed timer, done fade, failed
 * button behaviour, and the aria-live region.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StatusPill } from './StatusPill';

describe('StatusPill', () => {
  // Real timers by default; fake timers are opted into only by the tests below that need to
  // control the elapsed clock or the Done-fade timeout (combining fake timers with userEvent's
  // click simulation elsewhere in this file is unnecessary and adds flakiness risk).
  afterEach(() => {
    vi.useRealTimers();
  });

  // idle renders nothing at all.
  it('renders nothing for idle', () => {
    const { container } = render(<StatusPill phase="idle" startedAt={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  // Each non-idle phase renders its label with an aria-live region.
  it.each([
    ['queued', 'Queued'],
    ['preparing', 'Preparing'],
    ['succeeded', 'Done'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
  ] as const)('renders %s as "%s"', (phase, label) => {
    render(<StatusPill phase={phase} startedAt={null} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  // Running shows the label with a live elapsed timer appended.
  it('shows an elapsed timer while running', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    render(<StatusPill phase="running" startedAt={0} />);
    expect(screen.getByText(/^Running \d{2}:\d{2}$/)).toBeInTheDocument();
  });

  // The pill text sits in an aria-live="polite" region.
  it('wraps the text in an aria-live polite region', () => {
    render(<StatusPill phase="queued" startedAt={null} />);
    const live = screen.getByText('Queued');
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  // A "Done" pill fades (opacity-0) 5 s after render but stays mounted.
  it('fades a Done pill after 5 s while staying in the DOM', () => {
    vi.useFakeTimers();
    render(<StatusPill phase="succeeded" startedAt={null} />);
    const label = screen.getByText('Done');
    expect(label.closest('div')).not.toHaveClass('opacity-0');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(label.closest('div')).toHaveClass('opacity-0');
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  // A phase change away from succeeded before the fade fires cancels it (no stray timeout).
  it('cancels the pending fade when the phase changes before it fires', () => {
    vi.useFakeTimers();
    const { rerender } = render(<StatusPill phase="succeeded" startedAt={null} />);
    rerender(<StatusPill phase="running" startedAt={0} />);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.queryByText('Done')).toBeNull();
  });

  // Failed with onClick renders as a button and fires the callback.
  it('renders failed as a clickable button when onClick is provided', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<StatusPill phase="failed" startedAt={null} onClick={onClick} />);
    const button = screen.getByRole('button');
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // Failed without onClick renders as a non-interactive element.
  it('renders failed as non-interactive when onClick is omitted', () => {
    render(<StatusPill phase="failed" startedAt={null} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});
