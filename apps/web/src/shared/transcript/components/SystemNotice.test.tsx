/**
 * Tests for the system notice line: tones, duration and role.
 */
import { GITHUB_CANARY } from '@agent-hangar/core/testing';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SystemNotice } from './SystemNotice';

describe('SystemNotice', () => {
  // Info tone renders muted text with the status role for assistive tech.
  it('renders the info tone with role=status', () => {
    render(<SystemNotice tone="info" text="Cloning repository…" />);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Cloning repository…');
    expect(notice).toHaveClass('text-muted-foreground');
  });

  // Warning tone renders the warning token colour.
  it('renders the warning tone with the warning colour', () => {
    render(<SystemNotice tone="warning" text="Turn cancelled." />);
    expect(screen.getByRole('status')).toHaveClass('text-warning');
  });

  // Success tone renders (muted text per the design, success is conveyed by the icon).
  it('renders the success tone', () => {
    render(<SystemNotice tone="success" text="Pushed agent/k3x9 @ abcdef1" />);
    expect(screen.getByText('Pushed agent/k3x9 @ abcdef1')).toBeInTheDocument();
  });

  // A duration is shown, formatted, when provided.
  it('shows a formatted duration when provided', () => {
    render(<SystemNotice tone="success" text="Prepared agent/k3x9 at abcdef1" durationMs={2100} />);
    expect(screen.getByText('2.1 s')).toBeInTheDocument();
  });

  // No duration text renders when durationMs is omitted.
  it('omits the duration when not provided', () => {
    render(<SystemNotice tone="info" text="Cloning…" />);
    expect(screen.queryByText(/\ds$/)).toBeNull();
  });

  // A secret shape in the text (a raw prepare.progress message from the workspace agent) is
  // masked before rendering, defence in depth on top of the worker's own redaction.
  it('masks a secret shape in the text', () => {
    render(<SystemNotice tone="info" text={`token=${GITHUB_CANARY}`} />);
    expect(screen.queryByText(GITHUB_CANARY, { exact: false })).toBeNull();
    expect(screen.getByText('token=[REDACTED]')).toBeInTheDocument();
  });
});
