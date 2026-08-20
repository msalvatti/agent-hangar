/**
 * Tests for the chat route.
 *
 * Layer: unit.
 * Goal: the chat named in the path is the chat that opens.
 * Mocks: the chats feature, so the assertion is about what the route passes down rather than about
 * what the view makes of it.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ChatPage, { metadata } from './page';

vi.mock('@/features/chats', () => ({
  ChatView: ({ chatId }: { chatId: string }) => <div data-testid="chat-view">{chatId}</div>,
}));

describe('ChatPage', () => {
  /**
   * The route parameter arrives as a promise, so the id reaches the view only if the route awaits
   * it first. Passing the unresolved promise through would type-check against nothing and render a
   * chat view pointed at no chat.
   */
  it('opens the chat named by the route parameter', async () => {
    render(await ChatPage({ params: Promise.resolve({ id: 'chat-42' }) }));

    expect(screen.getByTestId('chat-view')).toHaveTextContent('chat-42');
  });

  /** The tab reads "Chat" until the view has a subject to put there. */
  it('titles the tab', () => {
    expect(metadata.title).toBe('Chat');
  });
});
