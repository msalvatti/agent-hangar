/**
 * Tests for what the shell renders on the server, where no viewport and no storage exist.
 *
 * The sidebar reads three preferences through `useSyncExternalStore`; each one needs a value for
 * the server pass, and those values decide the markup the browser hydrates against.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { useMediaQuery } from '../hooks/useMediaQuery';
import { SIDEBAR_WIDTH_STORAGE_KEY, useSidebarWidth } from '../hooks/useSidebarWidth';
import { useTheme } from '../hooks/useTheme';

import { ChatList } from './ChatList';

/** Renders the server value of a media query. */
function MediaProbe({ serverValue }: { serverValue: boolean }) {
  return <span>{String(useMediaQuery('(min-width: 1024px)', serverValue))}</span>;
}

/** Renders the server value of the theme preference. */
function ThemeProbe() {
  return <span>{useTheme().theme}</span>;
}

/** Renders the server value of the stored sidebar shape. */
function SidebarWidthProbe() {
  return <span>{useSidebarWidth().width}</span>;
}

describe('server rendering', () => {
  afterEach(() => {
    localStorage.clear();
  });

  // Without a viewport to measure, the caller's stated fallback is what the markup shows.
  it.each([true, false])('uses the media-query fallback %s', (serverValue) => {
    expect(renderToStaticMarkup(<MediaProbe serverValue={serverValue} />)).toContain(
      String(serverValue),
    );
  });

  // Without storage to read, the theme is the system one — the same default the bootstrap uses.
  it('falls back to the system theme', () => {
    expect(renderToStaticMarkup(<ThemeProbe />)).toContain('system');
  });

  /*
   * The sidebar shape is a stored preference too, and the server has no storage to read it from.
   * Storage is deliberately populated here: the server pass must answer `auto` even so, because a
   * pass that reached for the stored value would produce markup the browser cannot reproduce for
   * the visitor whose storage says something else.
   */
  it('falls back to the automatic sidebar shape', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, 'rail');
    expect(renderToStaticMarkup(<SidebarWidthProbe />)).toContain('auto');
  });

  // The archive renders collapsed, so a stored preference cannot desynchronise hydration.
  it('renders the chat list without an expanded archive', () => {
    const markup = renderToStaticMarkup(<ChatList activeId={null} />);
    expect(markup).toContain('Chats');
    expect(markup).not.toContain('Archived chats');
  });
});
