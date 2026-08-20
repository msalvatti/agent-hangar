/**
 * Unit tests for `CronPreview`.
 *
 * Layer: unit.
 * Goal: shows the empty hint, the reason a schedule is unusable, or the description plus the next
 * run, and stays an `aria-live` region in every state.
 * Mocks: none.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CronPreview } from './CronPreview';

describe('CronPreview', () => {
  /** An empty field is not an error: the preview invites the five fields instead of scolding. */
  it('shows a hint when empty', () => {
    render(<CronPreview cron="" timezone="UTC" />);
    expect(screen.getByText('Enter a cron expression (5 fields).')).toHaveAttribute(
      'aria-live',
      'polite',
    );
  });

  /** A malformed expression states what the parser refused, next to the field being typed in. */
  it('shows the reason an expression was refused', () => {
    render(<CronPreview cron="nope" timezone="UTC" />);
    expect(screen.getByText(/Invalid cron expression: expected 5 fields/)).toBeInTheDocument();
  });

  /**
   * A well-formed expression in a timezone the runtime does not know has no next run either;
   * the preview reports that instead of claiming a schedule it cannot project.
   */
  it('shows the reason when the timezone is unknown', () => {
    render(<CronPreview cron="0 9 * * 1" timezone="Not/AZone" />);
    expect(
      screen.getByText('Invalid cron expression: unknown IANA timezone: Not/AZone'),
    ).toBeInTheDocument();
  });

  /** A usable schedule reads as a sentence and names when it fires next. */
  it('shows the description and next run for a usable schedule', () => {
    render(<CronPreview cron="0 9 * * 1" timezone="UTC" />);
    expect(screen.getByText(/Runs every Mon at 09:00 UTC/)).toBeInTheDocument();
    expect(screen.getByText(/next:/)).toBeInTheDocument();
  });
});
