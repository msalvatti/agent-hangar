/**
 * Tests for `useMediaQuery`: reading a media query and reacting to it changing.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { stubMatchMedia } from '../testing/media-query';
import type { MatchMediaStub } from '../testing/media-query';

import { useMediaQuery } from './useMediaQuery';

let media: MatchMediaStub | null = null;

describe('useMediaQuery', () => {
  afterEach(() => {
    media?.restore();
    media = null;
  });

  // The current match is what the hook reports on first render.
  it('reports whether the query matches', () => {
    media = stubMatchMedia(['(min-width: 1024px)']);
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)', false));
    expect(result.current).toBe(true);
  });

  // A query that does not match reports false.
  it('reports false for a query that does not match', () => {
    media = stubMatchMedia([]);
    const { result } = renderHook(() => useMediaQuery('(min-width: 1024px)', true));
    expect(result.current).toBe(false);
  });

  // Resizing the viewport must move the component to the other layout.
  it('re-renders when the query starts matching', () => {
    media = stubMatchMedia([]);
    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)', false));
    act(() => {
      media?.set(['(min-width: 768px)']);
    });
    expect(result.current).toBe(true);
  });

  /**
   * Unmounting drops the listener. Counted rather than inferred from nothing throwing: a leaked
   * listener throws nothing either — it goes on running against a component that is gone, once per
   * mount, for the life of the page.
   */
  it('removes its listener on unmount', () => {
    media = stubMatchMedia([]);
    const { unmount } = renderHook(() => useMediaQuery('(min-width: 768px)', false));
    expect(media.listenerCount('(min-width: 768px)')).toBe(1);

    unmount();

    expect(media.listenerCount('(min-width: 768px)')).toBe(0);
  });

  /**
   * The listener is registered for `change`, which is the only event a `MediaQueryList` emits.
   * Registered under any other name it is never called, and the layout stays on whichever branch
   * the first render happened to pick.
   */
  it('listens for the change event and no other', () => {
    media = stubMatchMedia([]);
    renderHook(() => useMediaQuery('(min-width: 768px)', false));

    expect(media.listenerCount('(min-width: 768px)', 'change')).toBe(1);
  });

  /**
   * A component that asks about a different query gets an answer about that query — the hook is
   * used with more than one breakpoint, and a subscription left on the first one reports the wrong
   * viewport for the rest of the component's life.
   */
  it('follows the query it is currently given', () => {
    media = stubMatchMedia(['(min-width: 1024px)']);
    const { result, rerender } = renderHook(
      ({ query }: { query: string }) => useMediaQuery(query, false),
      { initialProps: { query: '(min-width: 768px)' } },
    );
    expect(result.current).toBe(false);

    rerender({ query: '(min-width: 1024px)' });

    expect(result.current).toBe(true);
    expect(media.listenerCount('(min-width: 768px)')).toBe(0);
    expect(media.listenerCount('(min-width: 1024px)')).toBe(1);

    act(() => {
      media?.set([]);
    });
    expect(result.current).toBe(false);
  });
});
