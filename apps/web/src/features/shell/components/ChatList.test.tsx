/**
 * Tests for `ChatList`: the sidebar's chat sections, their states and keyboard navigation.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { server } from '@/mocks/server';
import { store } from '@/mocks/store';

import { ARCHIVED_OPEN_KEY, ChatList } from './ChatList';

describe('ChatList', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // Skeleton rows reserve the list's space instead of shifting the sidebar on arrival.
  it('shows skeleton rows while loading', () => {
    render(<ChatList activeId={null} />);
    expect(screen.getByTestId('chat-list-skeleton')).toBeInTheDocument();
  });

  // The active chats are listed under the CHATS label, newest activity first.
  it('lists the active chats', async () => {
    render(<ChatList activeId={null} />);
    const list = await screen.findByRole('list', { name: 'Chats' });
    expect(within(list).getAllByRole('link').length).toBe(
      store.chats.filter((entry) => entry.chat.status === 'ACTIVE').length,
    );
  });

  // A queued turn and a failed one are announced in words, not only as a coloured dot.
  it('announces the queued and failed states in text', async () => {
    render(<ChatList activeId={null} />);
    await screen.findByRole('list', { name: 'Chats' });
    expect(screen.getByText('queued')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  // The open chat is marked as the current page.
  it('marks the open chat', async () => {
    render(<ChatList activeId="chat-running" />);
    const list = await screen.findByRole('list', { name: 'Chats' });
    expect(within(list).getByRole('link', { current: 'page' })).toBeInTheDocument();
  });

  // Only one row is in the tab order; the arrows move focus inside the list.
  it('moves focus with the arrow keys and Home/End', async () => {
    render(<ChatList activeId={null} />);
    const list = await screen.findByRole('list', { name: 'Chats' });
    const links = within(list).getAllByRole('link');
    links[0]?.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(links[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(links[0]).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(links.at(-1)).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(links[0]).toHaveFocus();
  });

  // A key that does not navigate leaves the focus where it was.
  it('ignores keys that do not navigate', async () => {
    render(<ChatList activeId={null} />);
    const list = await screen.findByRole('list', { name: 'Chats' });
    const links = within(list).getAllByRole('link');
    links[0]?.focus();
    await userEvent.keyboard('x');
    expect(links[0]).toHaveFocus();
  });

  // The archive starts collapsed and remembers being opened.
  it('expands the archive and persists the choice', async () => {
    render(<ChatList activeId={null} />);
    const trigger = await screen.findByRole('button', { name: /Archived/ });
    expect(screen.queryByRole('list', { name: 'Archived chats' })).not.toBeInTheDocument();
    await userEvent.click(trigger);
    expect(await screen.findByRole('list', { name: 'Archived chats' })).toBeInTheDocument();
    expect(localStorage.getItem(ARCHIVED_OPEN_KEY)).toBe('true');
  });

  // A stored preference reopens the archive on the next mount.
  it('restores the archive open state', async () => {
    localStorage.setItem(ARCHIVED_OPEN_KEY, 'true');
    render(<ChatList activeId={null} />);
    expect(await screen.findByRole('list', { name: 'Archived chats' })).toBeInTheDocument();
  });

  // An empty account gets a sentence, not an empty box.
  it('shows the empty state', async () => {
    server.use(http.get('/api/chats', () => HttpResponse.json({ chats: [] })));
    render(<ChatList activeId={null} />);
    expect(await screen.findByText('No chats yet.')).toBeInTheDocument();
  });

  // A failure is recoverable: the section offers Retry, which reloads both lists.
  it('offers a retry when the lists fail', async () => {
    let failing = true;
    server.use(
      http.get('/api/chats', () => {
        if (failing) {
          return HttpResponse.json({ error: { code: 'BOOM', message: 'nope' } }, { status: 500 });
        }
        return undefined;
      }),
    );
    render(<ChatList activeId={null} />);
    expect(await screen.findByText('nope')).toBeInTheDocument();
    failing = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.getByRole('list', { name: 'Chats' })).toBeInTheDocument();
    });
  });
});
