/**
 * Tests for `useSidebarWidth` and `railShape`: the stored sidebar shape and how it is resolved
 * against the viewport.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { railShape, SIDEBAR_WIDTH_STORAGE_KEY, useSidebarWidth } from './useSidebarWidth';
import type { SidebarWidth } from './useSidebarWidth';

describe('useSidebarWidth', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  /*
   * Nothing stored means nothing has been chosen, and the caller is free to follow the viewport.
   * This is also the value the server pass reports, so it is what the first render settles on.
   */
  it('reports auto while nothing has been chosen', () => {
    const { result } = renderHook(() => useSidebarWidth());
    expect(result.current.width).toBe('auto');
  });

  // A choice made in an earlier session is read back rather than re-derived from the viewport.
  it.each(['rail', 'column'] as const)('reads the stored %s choice', (stored) => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, stored);
    const { result } = renderHook(() => useSidebarWidth());
    expect(result.current.width).toBe(stored);
  });

  /*
   * Storage is shared with the rest of the browser and can hold anything, including a value from
   * an older build. Anything unrecognised means "no choice", not a shape.
   */
  it('treats an unrecognised stored value as auto', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, 'wide');
    const { result } = renderHook(() => useSidebarWidth());
    expect(result.current.width).toBe('auto');
  });

  // Writing both stores the choice and re-renders whoever is subscribed to it.
  it('stores a choice and republishes it to subscribers', () => {
    const { result } = renderHook(() => useSidebarWidth());
    act(() => {
      result.current.setWidth('rail');
    });
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('rail');
    expect(result.current.width).toBe('rail');
  });
});

describe('railShape', () => {
  /*
   * The whole truth table, because the two inputs disagree in exactly the cases that matter: an
   * explicit choice has to survive a viewport that would have picked the other shape, and `auto`
   * has to keep following the viewport in both directions.
   */
  it.each([
    ['auto', true, false],
    ['auto', false, true],
    ['rail', true, true],
    ['rail', false, true],
    ['column', true, false],
    ['column', false, false],
  ] as readonly (readonly [SidebarWidth, boolean, boolean])[])(
    'resolves %s with room-for-column %s to rail=%s',
    (width, roomForColumn, expected) => {
      expect(railShape(width, roomForColumn)).toBe(expected);
    },
  );
});
