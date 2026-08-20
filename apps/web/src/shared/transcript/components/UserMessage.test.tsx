/**
 * Tests for the user-message transcript row.
 */
import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UserMessage } from './UserMessage';

describe('UserMessage', () => {
  // The "You" label and the message text both render.
  it('renders the You label and the message text', () => {
    render(<UserMessage text="Fix the flaky test" />);
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Fix the flaky test')).toBeInTheDocument();
  });

  // Whitespace/newlines in the text are preserved (pre-wrap), not collapsed.
  it('preserves whitespace in multi-line text', () => {
    render(<UserMessage text={'line one\nline two'} />);
    const bubble = screen.getByText((_, element) => element?.textContent === 'line one\nline two');
    expect(bubble).toHaveClass('whitespace-pre-wrap');
  });

  // A prompt is operator-typed, so it is the one transcript string a credential can enter by
  // hand. It goes through the same display-layer masking as every other row: the token shape must
  // not survive on screen after the prompt is submitted.
  it.each([GITHUB_CANARY, OPENAI_CANARY])('masks a secret shape in the prompt', (canary) => {
    render(<UserMessage text={`use ${canary} to clone`} />);
    expect(screen.getByText('use [REDACTED] to clone')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(canary);
  });

  // data-item-kind identifies the row for the Transcript container's keyed rendering.
  it('carries data-item-kind="user"', () => {
    const { container } = render(<UserMessage text="hi" />);
    expect(container.querySelector('[data-item-kind="user"]')).not.toBeNull();
  });
});
