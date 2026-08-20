/**
 * Tests for the scheduled-jobs route.
 *
 * Layer: unit.
 * Goal: `/scheduled` is the list of jobs.
 * Mocks: the scheduled feature.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ScheduledPage, { metadata } from './page';

vi.mock('@/features/scheduled', () => ({
  ScheduledView: () => <div data-testid="scheduled-view" />,
}));

describe('ScheduledPage', () => {
  /** The sidebar's Scheduled entry leads here, so the route has to be the list and not a job. */
  it('renders the scheduled-jobs list', () => {
    render(<ScheduledPage />);

    expect(screen.getByTestId('scheduled-view')).toBeInTheDocument();
  });

  /** The tab names the section. */
  it('titles the tab', () => {
    expect(metadata.title).toBe('Scheduled — Agent Hangar');
  });
});
