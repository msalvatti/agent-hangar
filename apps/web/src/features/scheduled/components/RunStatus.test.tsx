/**
 * Unit tests for `RunStatus`.
 *
 * Layer: unit.
 * Goal: every status renders icon + text (never colour alone), the relative time shows when
 * given, and an overlap-skip error adds an explanatory tooltip.
 * Mocks: none.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { RunStatus } from './RunStatus';

describe('RunStatus', () => {
  /** SUCCEEDED renders its label text. */
  it('renders the SUCCEEDED label', () => {
    render(<RunStatus status="SUCCEEDED" />);
    expect(screen.getByText('ok')).toBeInTheDocument();
  });

  /** FAILED renders its label text. */
  it('renders the FAILED label', () => {
    render(<RunStatus status="FAILED" />);
    expect(screen.getByText('fail')).toBeInTheDocument();
  });

  /** A relative time is shown when `at` is given. */
  it('shows a relative time when at is given', () => {
    render(<RunStatus status="SUCCEEDED" at={new Date().toISOString()} />);
    expect(screen.getByText('just now')).toBeInTheDocument();
  });

  /** No relative time is shown when `at` is absent. */
  it('shows no relative time when at is absent', () => {
    render(<RunStatus status="SUCCEEDED" />);
    expect(screen.queryByText('just now')).not.toBeInTheDocument();
  });

  /** An overlap-skip error wraps the label in a tooltip explaining the skip. */
  it('shows an overlap tooltip when the run was skipped', async () => {
    const user = userEvent.setup();
    render(<RunStatus status="FAILED" error="previous run still running" />);
    await user.hover(screen.getByText('fail'));
    expect(
      await screen.findByText('Skipped: the previous run was still running'),
    ).toBeInTheDocument();
  });

  /** A non-overlap error renders the label without a tooltip. */
  it('renders no tooltip for a non-overlap error', () => {
    render(<RunStatus status="FAILED" error="something else broke" />);
    expect(
      screen.queryByText('Skipped: the previous run was still running'),
    ).not.toBeInTheDocument();
  });
});
