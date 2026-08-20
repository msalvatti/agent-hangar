/**
 * Unit tests for `CronField`.
 *
 * Layer: unit.
 * Goal: typing updates the value immediately but the preview only after the 150 ms debounce, and
 * each quick-fill example sets the value.
 * Mocks: fake timers for the debounce.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CronField } from './CronField';

afterEach(() => {
  vi.useRealTimers();
});

describe('CronField', () => {
  /** The input reflects the controlled value immediately. */
  it('renders the current value', () => {
    render(<CronField value="0 9 * * 1" onChange={vi.fn()} timezone="UTC" />);
    expect(screen.getByLabelText('Cron')).toHaveValue('0 9 * * 1');
  });

  /** The preview updates only after the debounce delay. */
  it('debounces the preview by 150ms', () => {
    vi.useFakeTimers();
    const { rerender } = render(<CronField value="" onChange={vi.fn()} timezone="UTC" />);
    expect(screen.getByText('Enter a cron expression (5 fields).')).toBeInTheDocument();

    rerender(<CronField value="0 9 * * 1" onChange={vi.fn()} timezone="UTC" />);
    // Not yet updated: the debounce has not elapsed.
    expect(screen.getByText('Enter a cron expression (5 fields).')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText(/Runs every Mon at 09:00 UTC/)).toBeInTheDocument();
  });

  /** Clicking a quick-fill example sets the value. */
  it('sets the value from a quick-fill example', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CronField value="" onChange={onChange} timezone="UTC" />);
    await user.click(screen.getByRole('button', { name: 'Weekdays 09:00' }));
    expect(onChange).toHaveBeenCalledWith('0 9 * * 1-5');
  });

  /** An error renders under the field. */
  it('renders a field error', () => {
    render(<CronField value="" onChange={vi.fn()} timezone="UTC" error="Required." />);
    expect(screen.getByText('Required.')).toBeInTheDocument();
  });
});
