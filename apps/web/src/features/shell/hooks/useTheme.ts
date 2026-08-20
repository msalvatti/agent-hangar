/**
 * Reads and writes the theme preference, keeping the root layout's inline bootstrap script as the
 * single source of truth for how a preference becomes a class.
 *
 * Layer: feature (hook).
 */
'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { DARK_CLASS, useResolvedTheme } from '@/shared/lib/theme';
import type { ResolvedTheme } from '@/shared/lib/theme';

import { readPersisted, subscribePersisted, writePersisted } from '../lib/persisted';

/** Stored preference; `system` follows the operating system. */
export type ThemePreference = 'system' | 'light' | 'dark';

/** `localStorage` key the root layout's bootstrap script reads. */
export const THEME_STORAGE_KEY = 'theme';

/** Media query the `system` preference follows. */
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Order the single-button toggle cycles through. */
const NEXT_THEME: Readonly<Record<ThemePreference, ThemePreference>> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

/** Result of {@link useTheme}. */
export interface UseThemeResult {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  /** Steps to the next preference in the cycle, for a single-button toggle. */
  cycle: () => void;
  resolved: ResolvedTheme;
}

/**
 * Reads the stored preference, treating anything unrecognised as `system`.
 *
 * @returns The stored preference.
 */
function readStoredTheme(): ThemePreference {
  const stored = readPersisted(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/**
 * Preference assumed while server-rendering, where no storage is readable.
 *
 * @returns `system`.
 */
function systemTheme(): ThemePreference {
  return 'system';
}

/**
 * Applies a preference to the document element, the same way the bootstrap script does.
 *
 * @param theme - The preference to apply.
 */
function applyTheme(theme: ThemePreference): void {
  const dark =
    theme === 'dark' || (theme === 'system' && globalThis.matchMedia(DARK_QUERY).matches);
  document.documentElement.classList.toggle(DARK_CLASS, dark);
}

/**
 * Exposes the theme preference, the resolved palette, and the controls the toggle needs.
 *
 * @returns The preference, a setter, a cycler and the resolved palette.
 */
export function useTheme(): UseThemeResult {
  const theme = useSyncExternalStore(subscribePersisted, readStoredTheme, systemTheme);
  const resolved = useResolvedTheme();

  useEffect(() => {
    if (theme !== 'system') {
      return;
    }
    const list = globalThis.matchMedia(DARK_QUERY);
    const onChange = (): void => {
      applyTheme('system');
    };
    list.addEventListener('change', onChange);
    return () => {
      list.removeEventListener('change', onChange);
    };
  }, [theme]);

  const setTheme = useCallback((next: ThemePreference) => {
    applyTheme(next);
    writePersisted(THEME_STORAGE_KEY, next);
  }, []);

  const cycle = useCallback(() => {
    setTheme(NEXT_THEME[theme]);
  }, [setTheme, theme]);

  return { theme, setTheme, cycle, resolved };
}
