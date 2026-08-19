/**
 * Tests for the inline error card: variants, code badge, actions, masking, and role.
 */
import { REDACTED_TOKEN } from '@agent-hangar/core';
import { GITHUB_CANARY } from '@agent-hangar/core/testing';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ErrorCard } from './ErrorCard';

describe('ErrorCard', () => {
  // Title and message render, and the card announces itself as an alert.
  it('renders the title and message with role=alert', () => {
    render(<ErrorCard title="Turn failed" message="Something went wrong" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Turn failed')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  // A code is shown as a small mono badge when provided.
  it('shows the code badge when provided', () => {
    render(<ErrorCard title="Turn failed" message="msg" code="WORKSPACE_IMAGE_MISSING" />);
    expect(screen.getByText('WORKSPACE_IMAGE_MISSING')).toBeInTheDocument();
  });

  // The code badge is masked like the message: a leaked credential must not reach the screen
  // through the one field that is not prose.
  it('masks a secret shape in the code badge', () => {
    render(<ErrorCard title="Turn failed" message="msg" code={GITHUB_CANARY} />);
    expect(screen.queryByText(GITHUB_CANARY)).not.toBeInTheDocument();
    expect(screen.getByText(REDACTED_TOKEN)).toBeInTheDocument();
  });

  // No code badge renders when the prop is omitted.
  it('omits the code badge when not provided', () => {
    render(<ErrorCard title="Turn failed" message="msg" />);
    expect(screen.queryByText(/^[A-Z_]+$/)).toBeNull();
  });

  // Caller-supplied actions (e.g. a Retry button) render inside the card.
  it('renders caller-supplied actions', () => {
    render(
      <ErrorCard
        title="Turn failed"
        message="msg"
        actions={<button type="button">Retry</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  // The message is masked for secret shapes before display.
  it('masks a secret shape in the message', () => {
    render(<ErrorCard title="Auth error" message={`token ${GITHUB_CANARY} rejected`} />);
    expect(screen.getByText('token [REDACTED] rejected')).toBeInTheDocument();
  });

  // The compact variant is used for inline transcript rows (tighter padding).
  it('applies compact padding for the compact variant', () => {
    render(<ErrorCard title="Turn failed" message="msg" variant="compact" />);
    expect(screen.getByRole('alert')).toHaveClass('px-4');
  });
});
