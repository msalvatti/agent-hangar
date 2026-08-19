/**
 * Tests for `ChatHeader`: what the header shows per turn phase and chat status.
 */
import type { ChatSummary } from '@agent-hangar/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { TurnPhase } from '@/shared/transcript';

import { ChatHeader } from './ChatHeader';

/** A chat summary with one field varied. */
function chatWith(status: ChatSummary['status']): ChatSummary {
  return {
    id: 'chat-1',
    title: 'Fix flaky auth test',
    status,
    repoUrl: 'https://github.com/acme/api',
    baseBranch: 'main',
    workBranch: 'agent/k3x9',
    lastPushedSha: null,
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
    archivedAt: null,
    lastTurnStatus: null,
  };
}

/** Renders the header with spies for every action. */
function renderHeader(phase: TurnPhase, status: ChatSummary['status'] = 'ACTIVE') {
  const handlers = {
    onRename: vi.fn().mockResolvedValue(undefined),
    onStop: vi.fn(),
    onShowError: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onCopyId: vi.fn(),
    onDelete: vi.fn(),
  };
  render(
    <ChatHeader
      chat={chatWith(status)}
      phase={phase}
      startedAt={null}
      renaming={false}
      {...handlers}
    />,
  );
  return handlers;
}

describe('ChatHeader', () => {
  // The header names the chat and the repository it runs against.
  it('shows the title and the repository', () => {
    renderHeader('idle');
    expect(screen.getByRole('button', { name: 'Fix flaky auth test' })).toBeInTheDocument();
    expect(screen.getByText('acme/api · agent/k3x9')).toBeInTheDocument();
  });

  // Stop only makes sense while the turn can still be interrupted.
  it.each(['queued', 'preparing', 'running'] as const)('offers Stop while %s', (phase) => {
    renderHeader(phase);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  // Once the turn has settled the button is gone.
  it.each(['idle', 'succeeded', 'failed', 'cancelled'] as const)('hides Stop while %s', (phase) => {
    renderHeader(phase);
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  // Stopping goes through the confirmation the view owns.
  it('reports a Stop click', async () => {
    const handlers = renderHeader('running');
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(handlers.onStop).toHaveBeenCalledTimes(1);
  });

  // A failed pill is clickable and scrolls the error into view.
  it('reveals the error from the failed pill', async () => {
    const handlers = renderHeader('failed');
    await userEvent.click(screen.getByRole('button', { name: /Failed/ }));
    expect(handlers.onShowError).toHaveBeenCalledTimes(1);
  });

  // An archived chat cannot be renamed, so the title stops being a control.
  it('locks the title for an archived chat', () => {
    renderHeader('idle', 'ARCHIVED');
    expect(screen.getByRole('heading', { name: 'Fix flaky auth test' })).toBeInTheDocument();
  });
});
