/**
 * Unit tests for `CronPreview`.
 *
 * Layer: unit.
 * Goal: shows the empty hint, the invalid reason, or the description + next run, and is an
 * `aria-live` region throughout.
 * Mocks: none.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CronPreview } from './CronPreview';

describe('CronPreview', () => {
  /** An empty cron shows the entry hint. */
  it('shows a hint when empty', () => {
    render(<CronPreview cron="" timezone="UTC" />);
    const region = screen.getByText('Enter a cron expression (5 fields).');
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  /** An invalid cron shows its validation reason. */
  it('shows the invalid reason', () => {
    render(<CronPreview cron="nope" timezone="UTC" />);
    expect(screen.getByText(/Invalid cron expression:/)).toBeInTheDocument();
  });

  /** A valid cron shows the description and the next run time. */
  it('shows the description and next run for a valid cron', () => {
    render(<CronPreview cron="0 9 * * 1" timezone="UTC" />);
    expect(screen.getByText(/Runs every Monday at 09:00/)).toBeInTheDocument();
    expect(screen.getByText(/next:/)).toBeInTheDocument();
  });

  /** A syntactically valid but unsatisfiable cron shows the description with no next-run suffix. */
  it('omits the next-run suffix when the cron is unsatisfiable', () => {
    render(<CronPreview cron="0 0 30 2 *" timezone="UTC" />);
    expect(screen.getByText('Runs on schedule 0 0 30 2 * (UTC)')).toBeInTheDocument();
  });
});
