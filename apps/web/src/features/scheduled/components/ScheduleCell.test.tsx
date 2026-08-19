/**
 * Unit tests for `ScheduleCell`.
 *
 * Layer: unit.
 * Goal: the cron expression and timezone render, and hovering shows the human-readable tooltip.
 * Mocks: none.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ScheduleCell } from './ScheduleCell';

describe('ScheduleCell', () => {
  /** Cron and timezone render in the trigger. */
  it('renders the cron expression and timezone', () => {
    render(<ScheduleCell cron="0 2 * * *" timezone="UTC" />);
    expect(screen.getByText('0 2 * * *')).toBeInTheDocument();
    expect(screen.getByText('(UTC)')).toBeInTheDocument();
  });

  /** Hovering shows the human-readable description. */
  it('shows the description tooltip on hover', async () => {
    const user = userEvent.setup();
    render(<ScheduleCell cron="0 2 * * *" timezone="UTC" />);
    await user.hover(screen.getByText('0 2 * * *'));
    expect(await screen.findByText('Runs every day at 02:00 (UTC)')).toBeInTheDocument();
  });
});
