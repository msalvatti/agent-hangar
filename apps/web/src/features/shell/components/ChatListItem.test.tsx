/**
 * Tests for `ChatListItem`: the row's title, status dot and current-page marking.
 */
import type { ChatSummary } from '@agent-hangar/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChatListItem } from './ChatListItem';

/**
 * Builds a chat summary with one field varied.
 *
 * @param lastTurnStatus - Status of the chat's most recent turn.
 * @returns A chat summary.
 */
function chatWith(lastTurnStatus: ChatSummary['lastTurnStatus']): ChatSummary {
  return {
    id: 'chat-1',
    title: 'Fix flaky auth test',
    status: 'ACTIVE',
    repoUrl: 'https://github.com/acme/api',
    baseBranch: 'main',
    workBranch: null,
    lastPushedSha: null,
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
    archivedAt: null,
    lastTurnStatus,
  };
}

describe('ChatListItem', () => {
  // The row links to the chat and shows its title.
  it('links to the chat', () => {
    render(<ChatListItem chat={chatWith(null)} active={false} tabIndex={0} onFocus={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Fix flaky auth test' })).toHaveAttribute(
      'href',
      '/chats/chat-1',
    );
  });

  // Every in-flight and failed state is spelled out for assistive technology.
  it.each([
    ['QUEUED', 'queued'],
    ['PREPARING', 'preparing'],
    ['RUNNING', 'running'],
    ['FAILED', 'failed'],
  ] as const)('announces %s as %s', (status, label) => {
    render(<ChatListItem chat={chatWith(status)} active={false} tabIndex={0} onFocus={vi.fn()} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  // Settled and unknown states get no dot at all.
  it.each([null, 'SUCCEEDED', 'CANCELLED'] as const)('shows no dot for %s', (status) => {
    const { container } = render(
      <ChatListItem chat={chatWith(status)} active={false} tabIndex={0} onFocus={vi.fn()} />,
    );
    expect(container.querySelector('.rounded-full')).toBeNull();
  });

  // The open chat is marked as the current page, not merely styled.
  it('marks the open chat', () => {
    render(<ChatListItem chat={chatWith(null)} active tabIndex={0} onFocus={vi.fn()} />);
    expect(screen.getByRole('link')).toHaveAttribute('aria-current', 'page');
  });
});
