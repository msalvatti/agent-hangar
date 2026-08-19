/**
 * Unit tests for `EnvSummary`.
 *
 * Layer: unit.
 * Goal: renders the instance line and one row per check with its label, an unhealthy check shows
 * destructive styling and its detail, and a healthy check shows neither.
 * Mocks: none.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { HealthSummary } from '../lib/health';

import { EnvSummary } from './EnvSummary';

const healthy: HealthSummary = {
  instance: 'default',
  allOk: true,
  checks: [
    { id: 'db', label: 'Postgres', ok: true },
    { id: 'redis', label: 'Redis', ok: true },
    { id: 'docker', label: 'Docker', ok: true },
    { id: 'image', label: 'Workspace image', ok: true },
  ],
};

describe('EnvSummary', () => {
  /** Renders the instance line and every check's label. */
  it('renders the instance and every check label', () => {
    render(<EnvSummary summary={healthy} />);
    expect(screen.getByText('Instance default')).toBeInTheDocument();
    expect(screen.getByRole('list').children.length).toBe(4);
    expect(screen.getByText('Postgres')).toBeInTheDocument();
    expect(screen.getByText('Workspace image')).toBeInTheDocument();
  });

  /** A healthy check shows no detail text. */
  it('shows no detail for a healthy check', () => {
    render(<EnvSummary summary={healthy} />);
    expect(screen.queryByText('connection refused')).not.toBeInTheDocument();
  });

  /** An unhealthy check with a detail shows it. */
  it('shows the detail of an unhealthy check', () => {
    const withFailure: HealthSummary = {
      ...healthy,
      allOk: false,
      checks: [
        { id: 'db', label: 'Postgres', ok: false, detail: 'connection refused' },
        ...healthy.checks.slice(1),
      ],
    };
    render(<EnvSummary summary={withFailure} />);
    expect(screen.getByText('connection refused')).toBeInTheDocument();
  });
});
