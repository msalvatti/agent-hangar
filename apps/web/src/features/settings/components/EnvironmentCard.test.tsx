/**
 * Unit tests for `EnvironmentCard`.
 *
 * Layer: unit.
 * Goal: shows a skeleton while loading or before data arrives, renders the summary once loaded,
 * and shows an error card with a Retry action on failure.
 * Mocks: none — callbacks are `vi.fn()`.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { HealthSummary } from '../lib/health';

import { EnvironmentCard } from './EnvironmentCard';

const healthy: HealthSummary = {
  instance: 'default',
  allOk: true,
  checks: [{ id: 'db', label: 'Postgres', ok: true }],
};

describe('EnvironmentCard', () => {
  /** Shows a skeleton while loading. */
  it('shows a skeleton while loading', () => {
    render(<EnvironmentCard summary={undefined} loading error={undefined} refetch={vi.fn()} />);
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  /** Shows a skeleton before data arrives, even once loading has settled. */
  it('shows a skeleton when not loading but no summary yet', () => {
    render(
      <EnvironmentCard summary={undefined} loading={false} error={undefined} refetch={vi.fn()} />,
    );
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  /** Renders the summary once loaded. */
  it('renders the summary', () => {
    render(
      <EnvironmentCard summary={healthy} loading={false} error={undefined} refetch={vi.fn()} />,
    );
    expect(screen.getByText('Instance default')).toBeInTheDocument();
  });

  /** Shows an error card with a Retry action calling refetch. */
  it('shows an error card and retries', async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    render(<EnvironmentCard summary={undefined} loading={false} error="boom" refetch={refetch} />);
    expect(screen.getByText('Could not load environment')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
