/**
 * Tests for `useTheme`: reading, cycling and persisting the theme preference.
 */
import { readFile } from 'node:fs/promises';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DARK_CLASS } from '@/shared/lib/theme';

import { stubMatchMedia } from '../testing/media-query';
import type { MatchMediaStub } from '../testing/media-query';

import { THEME_STORAGE_KEY, useTheme } from './useTheme';

/** The query the `system` preference follows. */
const DARK_QUERY = '(prefers-color-scheme: dark)';

let media: MatchMediaStub | null = null;

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove(DARK_CLASS);
  });

  afterEach(() => {
    media?.restore();
    media = null;
  });

  // Nothing stored means the operating system decides.
  it('defaults to the system preference', () => {
    media = stubMatchMedia([]);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('system');
  });

  // A stored preference is read back on the next mount.
  it.each(['light', 'dark'] as const)('reads the stored %s preference', (stored) => {
    media = stubMatchMedia([]);
    localStorage.setItem(THEME_STORAGE_KEY, stored);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe(stored);
  });

  // The single button steps system → light → dark → system, persisting each step.
  it('cycles through the three preferences and persists them', () => {
    media = stubMatchMedia([]);
    const { result } = renderHook(() => useTheme());
    for (const expected of ['light', 'dark', 'system'] as const) {
      act(() => {
        result.current.cycle();
      });
      expect(result.current.theme).toBe(expected);
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(expected);
    }
  });

  // Choosing dark applies the class the palette hangs off, and light removes it again.
  it('toggles the dark class on the document element', () => {
    media = stubMatchMedia([]);
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setTheme('dark');
    });
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(true);
    expect(result.current.resolved).toBe('dark');
    act(() => {
      result.current.setTheme('light');
    });
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(false);
  });

  // Under `system`, the class follows the operating system switching to dark.
  it('follows the system preference while set to system', () => {
    media = stubMatchMedia([]);
    renderHook(() => useTheme());
    act(() => {
      media?.set([DARK_QUERY]);
    });
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(true);
  });

  // An explicit preference must not be overridden by the operating system changing.
  it('ignores the system preference once one is chosen', () => {
    media = stubMatchMedia([]);
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setTheme('light');
    });
    act(() => {
      media?.set([DARK_QUERY]);
    });
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(false);
  });

  /**
   * The operating system is consulted only for `system`. Choosing light on a machine already set to
   * dark is the whole point of the preference existing, and a light choice that still renders dark
   * is a setting the user cannot use.
   */
  it('honours a light preference on a dark machine', () => {
    media = stubMatchMedia([DARK_QUERY]);
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setTheme('light');
    });
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(false);
  });

  /**
   * The follow-the-system listener is registered for `change`, the only event a `MediaQueryList`
   * emits, and dropped when the hook goes away. Under any other name the class never follows the
   * machine; left behind, every mount adds one more listener writing to the document.
   */
  it('listens for the system change event and drops the listener', () => {
    media = stubMatchMedia([]);
    const { unmount } = renderHook(() => useTheme());
    expect(media.listenerCount(DARK_QUERY, 'change')).toBe(1);

    unmount();

    expect(media.listenerCount(DARK_QUERY, 'change')).toBe(0);
  });

  /**
   * The preference is stored under the key the pre-paint bootstrap script reads. They are two
   * separate pieces of code — the script runs in the document head before React exists — and if
   * they disagree the chosen theme is applied only after hydration, which is the flash of the wrong
   * palette on every load that the script exists to prevent.
   */
  it('stores the preference under the key the bootstrap script reads', async () => {
    const layout = await readFile(`${process.cwd()}/app/layout.tsx`, 'utf8');

    expect(layout).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
  });

  // Applying `system` while the operating system is dark resolves to the dark palette.
  it('resolves system to dark when the operating system is dark', () => {
    media = stubMatchMedia([DARK_QUERY]);
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setTheme('system');
    });
    expect(document.documentElement.classList.contains(DARK_CLASS)).toBe(true);
  });
});
