/**
 * Tests for `AppSidebar`: the three responsive shapes and the global shortcuts.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertPresent } from '@/shared/transcript';

import { stubMatchMedia } from '../testing/media-query';
import type { MatchMediaStub } from '../testing/media-query';

import { AppSidebar } from './AppSidebar';

const push = vi.fn();
const pathname = vi.fn(() => '/chats/new');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => pathname(),
}));

/** Viewport queries the sidebar reads. */
const FULL = '(min-width: 1024px)';
const RAIL = '(min-width: 768px)';

let media: MatchMediaStub | null = null;

describe('AppSidebar', () => {
  beforeEach(() => {
    push.mockClear();
    pathname.mockReturnValue('/chats/new');
    localStorage.clear();
  });

  afterEach(() => {
    media?.restore();
    media = null;
  });

  // On a desktop viewport the full 260 px column is shown with the chat list.
  it('renders the full column above 1024 px', async () => {
    media = stubMatchMedia([FULL, RAIL]);
    render(<AppSidebar />);
    expect(screen.getByTestId('sidebar-slot')).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Chats' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Agent Hangar home' })).toBeInTheDocument();
  });

  // Between 768 and 1023 px the column collapses to an icon rail without the chat list.
  it('renders the icon rail between 768 and 1024 px', () => {
    media = stubMatchMedia([RAIL]);
    render(<AppSidebar />);
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Chats' })).not.toBeInTheDocument();
  });

  // Below 768 px only the drawer trigger is on screen until it is opened.
  it('renders the drawer below 768 px', async () => {
    media = stubMatchMedia([]);
    render(<AppSidebar />);
    expect(screen.queryByTestId('sidebar-slot')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(await screen.findByRole('link', { name: 'Agent Hangar home' })).toBeInTheDocument();
  });

  /*
   * The drawer paints its own close button over its top-right corner, which is where the sidebar
   * header puts the search button. Two hit targets on one spot means the one underneath cannot be
   * reached at all, so the header row keeps that corner clear. jsdom lays nothing out, so this
   * pins the reservation; the geometry is what a browser measures.
   */
  it('keeps the drawer close button clear of the search button', async () => {
    media = stubMatchMedia([]);
    render(<AppSidebar />);
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

    const wordmark = await screen.findByRole('link', { name: 'Agent Hangar home' });
    const header = assertPresent(wordmark.parentElement, 'the wordmark sits in the header row');
    expect(within(header).getByRole('button', { name: /^Search chats/ })).toBeInTheDocument();
    expect(header).toHaveClass('pr-11');
  });

  // The same header outside the drawer has nothing painted over it, so it keeps the full width.
  it('does not reserve that room in the full column', async () => {
    media = stubMatchMedia([FULL, RAIL]);
    render(<AppSidebar />);

    const wordmark = await screen.findByRole('link', { name: 'Agent Hangar home' });
    const header = assertPresent(wordmark.parentElement, 'the wordmark sits in the header row');
    expect(within(header).getByRole('button', { name: /^Search chats/ })).toBeInTheDocument();
    expect(header).not.toHaveClass('pr-11');
  });

  // Dismissing the drawer itself (Escape, the close button, the backdrop) closes it without any
  // navigation happening.
  it('closes the drawer when it is dismissed', async () => {
    media = stubMatchMedia([]);
    render(<AppSidebar />);
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(await screen.findByRole('link', { name: 'Agent Hangar home' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Agent Hangar home' })).not.toBeInTheDocument();
    });
  });

  // The app layout persists across routes, so a drawer left open would cover the page the
  // operator just navigated to.
  it('closes the drawer once the path changes', async () => {
    media = stubMatchMedia([]);
    const { rerender } = render(<AppSidebar />);
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(await screen.findByRole('link', { name: 'Agent Hangar home' })).toBeInTheDocument();

    pathname.mockReturnValue('/chats/chat-running');
    rerender(<AppSidebar />);
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Agent Hangar home' })).not.toBeInTheDocument();
    });
  });

  // ⌘K opens the search palette from anywhere in the app.
  it('opens the search palette with the shortcut', async () => {
    media = stubMatchMedia([FULL, RAIL]);
    render(<AppSidebar />);
    await userEvent.keyboard('{Meta>}k{/Meta}');
    expect(await screen.findByPlaceholderText('Search chats…')).toBeInTheDocument();
  });

  // The sidebar's own search button opens the same palette.
  it('opens the search palette from the sidebar button', async () => {
    media = stubMatchMedia([FULL, RAIL]);
    render(<AppSidebar />);
    await userEvent.click(screen.getByRole('button', { name: /Search chats/ }));
    expect(await screen.findByPlaceholderText('Search chats…')).toBeInTheDocument();
  });

  // ⌘N and ⌘, navigate without touching the mouse.
  it.each([
    ['n', '/chats/new'],
    [',', '/settings'],
  ])('navigates with the %s shortcut', async (key, href) => {
    media = stubMatchMedia([FULL, RAIL]);
    render(<AppSidebar />);
    await userEvent.keyboard(`{Meta>}${key}{/Meta}`);
    expect(push).toHaveBeenCalledWith(href);
  });

  // An open chat is highlighted in the list; `/chats/new` highlights nothing there.
  it('marks the open chat in the list', async () => {
    media = stubMatchMedia([FULL, RAIL]);
    pathname.mockReturnValue('/chats/chat-running');
    render(<AppSidebar />);
    const list = await screen.findByRole('list', { name: 'Chats' });
    expect(list.querySelector('[aria-current="page"]')).not.toBeNull();
  });

  // The footer carries the environment pill and the theme toggle.
  it('renders the footer controls', async () => {
    media = stubMatchMedia([FULL, RAIL]);
    render(<AppSidebar />);
    expect(await screen.findByRole('button', { name: /Environment status/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Switch theme/ })).toBeInTheDocument();
  });
});
