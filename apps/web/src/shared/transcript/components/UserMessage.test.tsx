/**
 * Tests for the user-message transcript row.
 */
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

  // data-item-kind identifies the row for the Transcript container's keyed rendering.
  it('carries data-item-kind="user"', () => {
    const { container } = render(<UserMessage text="hi" />);
    expect(container.querySelector('[data-item-kind="user"]')).not.toBeNull();
  });
});
