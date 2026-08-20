/**
 * Tests for the scheduled-job detail route.
 *
 * Layer: unit.
 * Goal: the job named in the path is the job that opens.
 * Mocks: the scheduled feature.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ScheduledJobPage, { metadata } from './page';

vi.mock('@/features/scheduled', () => ({
  JobDetailView: ({ jobId }: { jobId: string }) => <div data-testid="job-detail">{jobId}</div>,
}));

describe('ScheduledJobPage', () => {
  /**
   * The route parameter arrives as a promise and reaches the view only if the route awaits it,
   * exactly as on the chat route — and the two ids come from separate tables, so a job page fed a
   * chat id would look like an empty job rather than like a mistake.
   */
  it('opens the job named by the route parameter', async () => {
    render(await ScheduledJobPage({ params: Promise.resolve({ id: 'job-7' }) }));

    expect(screen.getByTestId('job-detail')).toHaveTextContent('job-7');
  });

  /** The tab names the section. */
  it('titles the tab', () => {
    expect(metadata.title).toBe('Job — Agent Hangar');
  });
});
