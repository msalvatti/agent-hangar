/**
 * Tests for `ChatSearch`: the ⌘K palette over the chat titles.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/mocks/server';

import { ChatSearch } from './ChatSearch';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

describe('ChatSearch', () => {
  beforeEach(() => {
    push.mockClear();
  });

  // Closed, the palette renders nothing at all.
  it('renders nothing while closed', () => {
    render(<ChatSearch open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  // Open, it lists both groups of chats.
  it('lists active and archived chats', async () => {
    render(<ChatSearch open onOpenChange={vi.fn()} />);
    expect(await screen.findByRole('option', { name: 'Fix flaky auth test' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Refactor the queue consumer/ })).toBeInTheDocument();
  });

  // Typing narrows the list to the matching titles.
  it('filters by title', async () => {
    render(<ChatSearch open onOpenChange={vi.fn()} />);
    await screen.findByRole('option', { name: 'Fix flaky auth test' });
    await userEvent.type(screen.getByRole('combobox'), 'flaky');
    expect(screen.getByRole('option', { name: 'Fix flaky auth test' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Explain/ })).not.toBeInTheDocument();
  });

  // Choosing a chat navigates to it and closes the palette.
  it('navigates to the chosen chat and closes', async () => {
    const onOpenChange = vi.fn();
    render(<ChatSearch open onOpenChange={onOpenChange} />);
    await userEvent.click(await screen.findByRole('option', { name: 'Fix flaky auth test' }));
    expect(push).toHaveBeenCalledWith('/chats/chat-running');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // An archived chat is reachable from the palette too.
  it('navigates to an archived chat', async () => {
    render(<ChatSearch open onOpenChange={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole('option', { name: /Refactor the queue consumer/ }),
    );
    expect(push).toHaveBeenCalledWith('/chats/chat-archived');
  });

  // With no chats at all the palette says so instead of showing an empty box.
  it('shows the empty message', async () => {
    server.use(http.get('/api/chats', () => HttpResponse.json({ chats: [] })));
    render(<ChatSearch open onOpenChange={vi.fn()} />);
    expect(await screen.findByText('No chats found.')).toBeInTheDocument();
  });
});
