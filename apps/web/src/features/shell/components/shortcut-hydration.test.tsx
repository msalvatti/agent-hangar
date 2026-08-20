/**
 * Tests that the sidebar's shortcut hints survive hydration.
 *
 * The defect these pin is not a wrong label — it is two renders disagreeing. The label used to be
 * decided by `navigator`, which the server does not have and the browser does, so the markup the
 * server produced and the markup React expected while hydrating it were different strings, and
 * React threw the hydrated tree away. Asserting the final label would say nothing about that, so
 * what is asserted here is the relationship between the two passes: the server markup may not
 * depend on the platform at all, and hydrating it in a browser of a different platform must raise
 * nothing.
 */
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import type { ReactElement } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubMatchMedia } from '../testing/media-query';
import type { MatchMediaStub } from '../testing/media-query';

import { SidebarBody } from './SidebarBody';

const pathname = vi.fn(() => '/chats/new');
vi.mock('next/navigation', () => ({ usePathname: () => pathname() }));

const MAC_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const LINUX_AGENT = 'Mozilla/5.0 (X11; Linux x86_64)';

// The theme toggle inside the sidebar subscribes to the colour-scheme query on mount, which jsdom
// does not implement.
let matchMedia: MatchMediaStub;

beforeEach(() => {
  matchMedia = stubMatchMedia([]);
});

afterEach(() => {
  matchMedia.restore();
  vi.restoreAllMocks();
});

/**
 * Reports what the shell says while a given browser is running it.
 *
 * jsdom always supplies a `navigator`, so "the server" is simulated the way the defect actually
 * showed up in production — two renders that read different user agents — rather than by deleting
 * the global, which would break jsdom itself.
 *
 * @param userAgent - What `navigator.userAgent` reports for the duration.
 * @param body - The rendering to perform.
 * @returns Whatever `body` returned.
 */
function asBrowser<T>(userAgent: string, body: () => T): T {
  const agent = vi.spyOn(globalThis.navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  try {
    return body();
  } finally {
    agent.mockRestore();
  }
}

/**
 * The sidebar, with the props the app layout passes it.
 *
 * @returns The element to render.
 */
function sidebar(): ReactElement {
  return (
    <SidebarBody compact={false} activeId={null} onOpenSearch={vi.fn()} onToggleWidth={vi.fn()} />
  );
}

describe('sidebar shortcut hints', () => {
  // The whole markup, not just the label: whatever the renderer's platform is, the bytes the
  // server sends must be the same, because the browser that hydrates them may be either one.
  it('renders the same server markup on every platform', () => {
    const fromMac = asBrowser(MAC_AGENT, () => renderToString(sidebar()));
    const fromLinux = asBrowser(LINUX_AGENT, () => renderToString(sidebar()));
    expect(fromMac).toBe(fromLinux);
  });

  // What that identical markup says: the control is named, and no shortcut is claimed for it yet.
  // A guess would be announced to whoever reached the button before the browser corrected it.
  it('claims no shortcut in the server markup', () => {
    const markup = asBrowser(MAC_AGENT, () => renderToString(sidebar()));
    expect(markup).toContain('aria-label="Search chats"');
    expect(markup).not.toContain('⌘K');
    expect(markup).not.toContain('Ctrl+K');
  });

  // The end state is still correct per platform: the shortcut appears once the browser has said
  // which one it is.
  it.each([
    [MAC_AGENT, 'Search chats (⌘K)'],
    [LINUX_AGENT, 'Search chats (Ctrl+K)'],
  ])('names the platform shortcut once the browser has it (%s)', (userAgent, expected) => {
    asBrowser(userAgent, () => {
      render(sidebar());
    });
    expect(screen.getByRole('button', { name: expected })).toBeInTheDocument();
  });

  // The end-to-end property: markup rendered without a browser, hydrated by a Mac, and React
  // reporting nothing. Only hydration warnings are inspected — the shell also fetches, and an
  // unrelated console line must not be able to make this pass or fail.
  it('hydrates server markup in a browser of another platform without a mismatch', async () => {
    const element = sidebar();
    const markup = asBrowser(LINUX_AGENT, () => renderToString(element));
    const container = document.createElement('div');
    container.innerHTML = markup;
    document.body.append(container);

    const logged: string[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(' '));
    });
    const agent = vi.spyOn(globalThis.navigator, 'userAgent', 'get').mockReturnValue(MAC_AGENT);
    const root = hydrateRoot(container, element);
    await act(async () => {
      await Promise.resolve();
    });
    agent.mockRestore();
    consoleError.mockRestore();
    root.unmount();
    container.remove();

    expect(logged.filter((line) => /hydrat/i.test(line))).toEqual([]);
  });
});
