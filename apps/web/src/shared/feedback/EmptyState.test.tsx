/**
 * Tests for the generic empty-state placeholder.
 */
import { render, screen } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  // The title always renders.
  it('renders the title', () => {
    render(<EmptyState icon={Inbox} title="No scheduled jobs yet." />);
    expect(screen.getByText('No scheduled jobs yet.')).toBeInTheDocument();
  });

  // The description renders when provided.
  it('renders the description when provided', () => {
    render(<EmptyState icon={Inbox} title="No chats yet" description="Start a new one." />);
    expect(screen.getByText('Start a new one.')).toBeInTheDocument();
  });

  // No description renders when the prop is omitted.
  it('omits the description when not provided', () => {
    render(<EmptyState icon={Inbox} title="No chats yet" />);
    expect(screen.queryByText('Start a new one.')).toBeNull();
  });

  // The action renders when provided.
  it('renders the action when provided', () => {
    render(
      <EmptyState
        icon={Inbox}
        title="No chats yet"
        action={<button type="button">New chat</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
  });
});
