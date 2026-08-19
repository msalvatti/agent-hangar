/**
 * Tests for what the shell renders on the server, where no viewport and no storage exist.
 *
 * The sidebar reads three preferences through `useSyncExternalStore`; each one needs a value for
 * the server pass, and those values decide the markup the browser hydrates against.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { useMediaQuery } from '../hooks/useMediaQuery';
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

describe('server rendering', () => {
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

  // The archive renders collapsed, so a stored preference cannot desynchronise hydration.
  it('renders the chat list without an expanded archive', () => {
    const markup = renderToStaticMarkup(<ChatList activeId={null} />);
    expect(markup).toContain('Chats');
    expect(markup).not.toContain('Archived chats');
  });
});
