/**
 * Tests for the new-chat route.
 *
 * Layer: unit.
 * Goal: `/chats/new` is the composition that starts a chat — the screen `/` redirects to.
 * Mocks: the chats feature.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import NewChatPage, { metadata } from './page';

vi.mock('@/features/chats', () => ({
  NewChatView: () => <div data-testid="new-chat-view" />,
}));

describe('NewChatPage', () => {
  /** The home of the app: `/` redirects here, so this route has to be the composer. */
  it('renders the new-chat composition', () => {
    render(<NewChatPage />);

    expect(screen.getByTestId('new-chat-view')).toBeInTheDocument();
  });

  /** The tab reads "New chat"; the product name is appended by the root layout's template. */
  it('titles the tab', () => {
    expect(metadata.title).toBe('New chat');
  });
});
