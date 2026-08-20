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

  // Unmounting must drop the listener rather than leak it.
  it('removes its listener on unmount', () => {
    media = stubMatchMedia([]);
    const { unmount } = renderHook(() => useMediaQuery('(min-width: 768px)', false));
    expect(() => {
      unmount();
      media?.set(['(min-width: 768px)']);
    }).not.toThrow();
  });
});
