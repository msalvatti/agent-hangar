/**
 * Tests for `PrimaryNav`: the three destinations and their active state.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrimaryNav } from './PrimaryNav';

const pathname = vi.fn(() => '/chats/new');
vi.mock('next/navigation', () => ({ usePathname: () => pathname() }));

describe('PrimaryNav', () => {
  beforeEach(() => {
    pathname.mockReturnValue('/chats/new');
  });

  // The sidebar offers exactly the three destinations of spec 10 §3.
  it('renders the three destinations', () => {
    render(<PrimaryNav />);
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    const entries: readonly (readonly [string, string])[] = [
      ['New chat', '/chats/new'],
      ['Scheduled', '/scheduled'],
      ['Settings', '/settings'],
    ];
    for (const [name, href] of entries) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
    }
  });

  // The row matching the path is marked for assistive technology, not only visually.
  it('marks the current route', () => {
    pathname.mockReturnValue('/settings');
    render(<PrimaryNav />);
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'New chat' })).not.toHaveAttribute('aria-current');
  });

  // An open chat is not the New chat page, so no row is highlighted there.
  it('marks nothing while a chat is open', () => {
    pathname.mockReturnValue('/chats/chat-running');
    render(<PrimaryNav />);
    expect(screen.queryByRole('link', { current: 'page' })).not.toBeInTheDocument();
  });

  // Rows with a shortcut advertise it in their tooltip.
  it('shows the shortcut in the tooltip', () => {
    render(<PrimaryNav />);
    expect(screen.getByRole('link', { name: 'New chat' }).title).toMatch(/New chat \(/);
    expect(screen.getByRole('link', { name: 'Scheduled' }).title).toBe('Scheduled');
  });

  // In the rail the labels are hidden visually but still name the links.
  it('keeps the links named in icon-only mode', () => {
    render(<PrimaryNav iconOnly />);
    expect(screen.getByRole('link', { name: 'Scheduled' })).toBeInTheDocument();
  });
});
